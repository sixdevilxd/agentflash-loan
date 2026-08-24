// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal Balancer v2 Vault surface used by FlashExecutor.
interface IBalancerVault {
    /// @dev Balancer flash loans are historically 0-fee. The receiver must
    ///      TRANSFER `amount + feeAmount` back (not approve) before returning.
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

interface IBalancerFlashLoanRecipient {
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external;
}
