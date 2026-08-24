// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBalancerFlashLoanRecipient} from "../../src/interfaces/IBalancerVault.sol";

/// @dev Mimics Balancer v2: 0 fee, recipient must push the repayment back.
contract MockBalancerVault {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external {
        uint256[] memory fees = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            IERC20(tokens[i]).transfer(recipient, amounts[i]);
            fees[i] = 0;
        }

        uint256 before = IERC20(tokens[0]).balanceOf(address(this));
        IBalancerFlashLoanRecipient(recipient).receiveFlashLoan(tokens, amounts, fees, userData);
        require(
            IERC20(tokens[0]).balanceOf(address(this)) >= before + amounts[0],
            "loan not repaid"
        );
    }
}
