// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal Aave v3 surface used by FlashExecutor.
interface IAaveV3Pool {
    /// @dev Single-asset flash loan. Calls back into `executeOperation` on the receiver.
    ///      The receiver must leave `amount + premium` approved to this pool.
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @dev Fee in bps (e.g. 5 == 0.05%). Read on-chain, never hardcode.
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IAaveV3FlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}
