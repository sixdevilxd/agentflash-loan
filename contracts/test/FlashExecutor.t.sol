// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {FlashExecutor} from "../src/FlashExecutor.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAavePool} from "./mocks/MockAavePool.sol";
import {MockBalancerVault} from "./mocks/MockBalancerVault.sol";
import {MockRouter} from "./mocks/MockRouter.sol";

contract FlashExecutorTest is Test {
    FlashExecutor exec;
    MockAavePool aave;
    MockBalancerVault balancer;
    MockERC20 usdc;
    MockERC20 weth;
    MockRouter dexA; // USDC -> WETH
    MockRouter dexB; // WETH -> USDC

    address admin;
    address guardian;
    address operator;
    address outsider;

    uint256 constant LOAN = 100_000e18;
    uint256 constant CAP = 1_000_000e18;

    function setUp() public {
        admin = makeAddr("admin");
        guardian = makeAddr("guardian");
        operator = makeAddr("operator");
        outsider = makeAddr("outsider");

        usdc = new MockERC20("USD Coin", "USDC");
        weth = new MockERC20("Wrapped Ether", "WETH");

        aave = new MockAavePool();
        balancer = new MockBalancerVault();

        // Profitable round trip: 100% -> 101% -> net +1% before fees.
        dexA = new MockRouter(10_000);
        dexB = new MockRouter(10_100);

        exec = new FlashExecutor(address(aave), address(balancer), admin, guardian);

        vm.startPrank(admin);
        exec.grantRole(exec.OPERATOR_ROLE(), operator);
        exec.setMaxLoan(address(usdc), CAP);
        exec.setTarget(address(dexA), true);
        exec.setTarget(address(dexB), true);
        vm.stopPrank();

        // Liquidity.
        usdc.mint(address(aave), 10_000_000e18);
        usdc.mint(address(balancer), 10_000_000e18);
        weth.mint(address(dexA), 10_000_000e18);
        usdc.mint(address(dexB), 10_000_000e18);
    }

    // ------------------------------------------------------------ helpers

    function _profitablePlan(FlashExecutor.Provider p, uint256 minProfit)
        internal
        view
        returns (FlashExecutor.Plan memory plan)
    {
        FlashExecutor.Approval[] memory apps = new FlashExecutor.Approval[](2);
        apps[0] = FlashExecutor.Approval(address(usdc), address(dexA), LOAN);
        apps[1] = FlashExecutor.Approval(address(weth), address(dexB), LOAN);

        FlashExecutor.Call[] memory calls = new FlashExecutor.Call[](2);
        calls[0] = FlashExecutor.Call(
            address(dexA),
            0,
            abi.encodeCall(MockRouter.swap, (address(usdc), address(weth), LOAN))
        );
        calls[1] = FlashExecutor.Call(
            address(dexB),
            0,
            abi.encodeCall(MockRouter.swap, (address(weth), address(usdc), LOAN))
        );

        plan = FlashExecutor.Plan({
            provider: p,
            asset: address(usdc),
            amount: LOAN,
            minProfit: minProfit,
            approvals: apps,
            calls: calls
        });
    }

    // -------------------------------------------------------- happy paths

    function test_aave_profitableRunKeepsProfit() public {
        vm.prank(operator);
        exec.run(_profitablePlan(FlashExecutor.Provider.AAVE_V3, 1e18));

        uint256 premium = (LOAN * 5) / 10_000;
        uint256 expected = (LOAN * 100) / 10_000 - premium; // 1% gain - 0.05% fee
        assertEq(usdc.balanceOf(address(exec)), expected, "profit retained");
    }

    function test_balancer_zeroFeeKeepsFullSpread() public {
        vm.prank(operator);
        exec.run(_profitablePlan(FlashExecutor.Provider.BALANCER_V2, 1e18));

        assertEq(usdc.balanceOf(address(exec)), (LOAN * 100) / 10_000, "full 1% kept");
    }

    // ------------------------------------------------- the core guarantee

    function test_revertsWhenProfitBelowMinProfit() public {
        // Ask for more profit than the spread can deliver.
        vm.prank(operator);
        vm.expectRevert();
        exec.run(_profitablePlan(FlashExecutor.Provider.AAVE_V3, 5_000e18));
    }

    function test_revertsWhenOpportunityVanishesMidFlight() public {
        // Simulation said 1% but the pool moved against us before inclusion.
        dexB.setRate(9_900);

        vm.prank(operator);
        vm.expectRevert();
        exec.run(_profitablePlan(FlashExecutor.Provider.AAVE_V3, 1e18));

        assertEq(usdc.balanceOf(address(exec)), 0, "no loss taken");
    }

    // ----------------------------------------------------- access control

    function test_outsiderCannotRun() public {
        vm.prank(outsider);
        vm.expectRevert();
        exec.run(_profitablePlan(FlashExecutor.Provider.AAVE_V3, 1e18));
    }

    function test_operatorCannotWithdraw() public {
        usdc.mint(address(exec), 1_000e18);
        vm.prank(operator);
        vm.expectRevert();
        exec.withdraw(address(usdc), operator, 1_000e18);
    }

    function test_adminCanWithdraw() public {
        usdc.mint(address(exec), 1_000e18);
        vm.prank(admin);
        exec.withdraw(address(usdc), admin, 1_000e18);
        assertEq(usdc.balanceOf(admin), 1_000e18);
    }

    // --------------------------------------------------- callback defence

    function test_directCallbackCallIsRejected() public {
        vm.prank(outsider);
        vm.expectRevert(FlashExecutor.NotPool.selector);
        exec.executeOperation(address(usdc), LOAN, 0, address(exec), "");
    }

    function test_poolCannotReplayForeignPlan() public {
        // Even the real pool address cannot inject a plan we never started.
        FlashExecutor.Plan memory rogue = _profitablePlan(FlashExecutor.Provider.AAVE_V3, 0);
        vm.prank(address(aave));
        vm.expectRevert(FlashExecutor.NoActivePlan.selector);
        exec.executeOperation(address(usdc), LOAN, 0, address(exec), abi.encode(rogue));
    }

    // --------------------------------------------------------- allowlists

    function test_unlistedRouterIsRejected() public {
        MockRouter rogue = new MockRouter(10_100);
        FlashExecutor.Plan memory plan = _profitablePlan(FlashExecutor.Provider.AAVE_V3, 0);
        plan.calls[1].target = address(rogue);

        vm.prank(operator);
        vm.expectRevert();
        exec.run(plan);
    }

    function test_loanAboveCapIsRejected() public {
        FlashExecutor.Plan memory plan = _profitablePlan(FlashExecutor.Provider.AAVE_V3, 0);
        plan.amount = CAP + 1;

        vm.prank(operator);
        vm.expectRevert();
        exec.run(plan);
    }

    function test_unlistedAssetIsRejected() public {
        FlashExecutor.Plan memory plan = _profitablePlan(FlashExecutor.Provider.AAVE_V3, 0);
        plan.asset = address(weth); // maxLoan never set
        vm.prank(operator);
        vm.expectRevert();
        exec.run(plan);
    }

    // ------------------------------------------------------------- pause

    function test_guardianPauseStopsExecution() public {
        vm.prank(guardian);
        exec.pause();

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        exec.run(_profitablePlan(FlashExecutor.Provider.AAVE_V3, 1e18));
    }

    // --------------------------------------------------------- allowances

    function test_noStandingAllowanceAfterRun() public {
        vm.prank(operator);
        exec.run(_profitablePlan(FlashExecutor.Provider.AAVE_V3, 1e18));

        assertEq(usdc.allowance(address(exec), address(dexA)), 0, "usdc allowance cleared");
        assertEq(weth.allowance(address(exec), address(dexB)), 0, "weth allowance cleared");
    }
}
