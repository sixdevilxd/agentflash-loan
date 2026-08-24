// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IAaveV3Pool, IAaveV3FlashLoanSimpleReceiver} from "./interfaces/IAaveV3Pool.sol";
import {IBalancerVault, IBalancerFlashLoanRecipient} from "./interfaces/IBalancerVault.sol";

/**
 * @title FlashExecutor
 * @notice Atomic flash-loan strategy executor.
 *
 * DESIGN INVARIANT
 * ----------------
 * Off-chain decides WHEN to try. This contract GUARANTEES we do not lose money.
 * A simulation at block N says nothing about block N+1, so profit is enforced
 * on-chain: if the realised balance delta is below `minProfit`, the whole
 * transaction reverts and we only pay gas.
 *
 * TRUST MODEL
 * -----------
 * OPERATOR_ROLE  - the agent's hot key. Can ONLY trigger `run`. Cannot withdraw,
 *                  cannot change config, cannot add routers. A leaked operator
 *                  key can waste gas; it cannot drain the contract.
 * GUARDIAN_ROLE  - can pause. Kept on a separate key/phone.
 * DEFAULT_ADMIN  - config + withdraw. Should be a cold key or multisig.
 *
 * Arbitrary calls are constrained to `allowedTarget` (routers only, never token
 * contracts) so a compromised operator cannot encode a plain ERC-20 transfer out.
 */
contract FlashExecutor is
    AccessControl,
    ReentrancyGuard,
    Pausable,
    IAaveV3FlashLoanSimpleReceiver,
    IBalancerFlashLoanRecipient
{
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    enum Provider {
        AAVE_V3,
        BALANCER_V2
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct Approval {
        address token;
        address spender;
        uint256 amount;
    }

    struct Plan {
        Provider provider;
        address asset;
        uint256 amount;
        uint256 minProfit;
        Approval[] approvals;
        Call[] calls;
    }

    IAaveV3Pool public immutable AAVE_POOL;
    IBalancerVault public immutable BALANCER_VAULT;

    /// @notice Routers/spenders the executor may touch. Never add token addresses.
    mapping(address => bool) public allowedTarget;

    /// @notice Per-asset borrow ceiling. 0 means the asset is not borrowable.
    mapping(address => uint256) public maxLoan;

    /// @dev keccak256 of the in-flight encoded Plan. Zero when idle.
    bytes32 private _activePlan;

    /// @dev Asset balance captured immediately before the borrow.
    uint256 private _snapshot;

    event Executed(
        address indexed asset, uint256 amount, uint256 owed, uint256 profit, Provider provider
    );
    event TargetSet(address indexed target, bool allowed);
    event MaxLoanSet(address indexed asset, uint256 cap);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotPool();
    error NotSelfInitiated();
    error NoActivePlan();
    error PlanMismatch();
    error AssetMismatch();
    error TargetNotAllowed(address target);
    error SpenderNotAllowed(address spender);
    error LoanExceedsCap(address asset, uint256 amount, uint256 cap);
    error ProfitBelowMin(uint256 have, uint256 need);
    error CallFailed(uint256 index, bytes reason);
    error BadProvider();

    constructor(address aavePool, address balancerVault, address admin, address guardian) {
        AAVE_POOL = IAaveV3Pool(aavePool);
        BALANCER_VAULT = IBalancerVault(balancerVault);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    // ---------------------------------------------------------------- entry

    /**
     * @notice Borrow, run the strategy, repay, and keep the profit.
     * @dev Reverts unless the realised gain is at least `plan.minProfit`.
     */
    function run(Plan calldata plan)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        uint256 cap = maxLoan[plan.asset];
        if (cap == 0 || plan.amount > cap) revert LoanExceedsCap(plan.asset, plan.amount, cap);

        bytes memory params = abi.encode(plan);
        _snapshot = IERC20(plan.asset).balanceOf(address(this));
        _activePlan = keccak256(params);

        if (plan.provider == Provider.AAVE_V3) {
            AAVE_POOL.flashLoanSimple(address(this), plan.asset, plan.amount, params, 0);
        } else if (plan.provider == Provider.BALANCER_V2) {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = plan.asset;
            amounts[0] = plan.amount;
            BALANCER_VAULT.flashLoan(address(this), tokens, amounts, params);
        } else {
            revert BadProvider();
        }

        _activePlan = bytes32(0);
        _snapshot = 0;
    }

    // ------------------------------------------------------------ callbacks

    /// @inheritdoc IAaveV3FlashLoanSimpleReceiver
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Anyone can call this selector. These two lines are the whole defence.
        if (msg.sender != address(AAVE_POOL)) revert NotPool();
        if (initiator != address(this)) revert NotSelfInitiated();

        Plan memory plan = _claim(params, asset);
        uint256 owed = amount + premium;

        _runCalls(plan);
        uint256 profit = _assertProfit(asset, owed, plan.minProfit);

        // Aave pulls the repayment.
        IERC20(asset).forceApprove(address(AAVE_POOL), owed);

        emit Executed(asset, amount, owed, profit, Provider.AAVE_V3);
        return true;
    }

    /// @inheritdoc IBalancerFlashLoanRecipient
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external override {
        if (msg.sender != address(BALANCER_VAULT)) revert NotPool();

        address asset = tokens[0];
        Plan memory plan = _claim(userData, asset);
        uint256 owed = amounts[0] + feeAmounts[0];

        _runCalls(plan);
        uint256 profit = _assertProfit(asset, owed, plan.minProfit);

        // Balancer expects a push, not an allowance.
        IERC20(asset).safeTransfer(address(BALANCER_VAULT), owed);

        emit Executed(asset, amounts[0], owed, profit, Provider.BALANCER_V2);
    }

    // ------------------------------------------------------------- internal

    /// @dev Binds the callback to the exact plan `run` started. Blocks a spoofed
    ///      pool from replaying a stale or attacker-authored plan.
    function _claim(bytes calldata params, address asset) private view returns (Plan memory plan) {
        if (_activePlan == bytes32(0)) revert NoActivePlan();
        if (keccak256(params) != _activePlan) revert PlanMismatch();
        plan = abi.decode(params, (Plan));
        if (plan.asset != asset) revert AssetMismatch();
    }

    function _runCalls(Plan memory plan) private {
        uint256 n = plan.approvals.length;
        for (uint256 i; i < n; ++i) {
            Approval memory a = plan.approvals[i];
            if (!allowedTarget[a.spender]) revert SpenderNotAllowed(a.spender);
            IERC20(a.token).forceApprove(a.spender, a.amount);
        }

        uint256 m = plan.calls.length;
        for (uint256 i; i < m; ++i) {
            Call memory c = plan.calls[i];
            if (!allowedTarget[c.target]) revert TargetNotAllowed(c.target);
            (bool ok, bytes memory ret) = c.target.call{value: c.value}(c.data);
            if (!ok) revert CallFailed(i, ret);
        }

        // Never leave a standing allowance behind.
        for (uint256 i; i < n; ++i) {
            IERC20(plan.approvals[i].token).forceApprove(plan.approvals[i].spender, 0);
        }
    }

    /// @dev The core guarantee. `_snapshot` is the pre-borrow balance, so the
    ///      borrowed principal is excluded from what counts as profit.
    function _assertProfit(address asset, uint256 owed, uint256 minProfit)
        private
        view
        returns (uint256 profit)
    {
        uint256 have = IERC20(asset).balanceOf(address(this));
        uint256 need = _snapshot + owed + minProfit;
        if (have < need) revert ProfitBelowMin(have, need);
        profit = have - _snapshot - owed;
    }

    // ---------------------------------------------------------------- admin

    function setTarget(address target, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    function setMaxLoan(address asset, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxLoan[asset] = cap;
        emit MaxLoanSet(asset, cap);
    }

    function withdraw(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    function withdrawNative(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "native transfer failed");
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    receive() external payable {}
}
