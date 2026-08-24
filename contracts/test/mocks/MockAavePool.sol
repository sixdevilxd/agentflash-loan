// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAaveV3FlashLoanSimpleReceiver} from "../../src/interfaces/IAaveV3Pool.sol";

/// @dev Mimics Aave v3: push the loan, call back, then pull principal + premium.
contract MockAavePool {
    uint128 public constant FLASHLOAN_PREMIUM_TOTAL = 5; // 5 bps

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        uint256 premium = (amount * FLASHLOAN_PREMIUM_TOTAL) / 10_000;
        IERC20(asset).transfer(receiver, amount);

        bool ok = IAaveV3FlashLoanSimpleReceiver(receiver).executeOperation(
            asset, amount, premium, receiver, params
        );
        require(ok, "callback returned false");

        // Aave pulls via allowance.
        IERC20(asset).transferFrom(receiver, address(this), amount + premium);
    }
}
