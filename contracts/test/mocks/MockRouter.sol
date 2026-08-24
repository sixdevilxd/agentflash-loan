// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Fixed-rate swap venue. `rateBps` = output per 10_000 input.
contract MockRouter {
    uint256 public rateBps;

    constructor(uint256 _rateBps) {
        rateBps = _rateBps;
    }

    function setRate(uint256 _rateBps) external {
        rateBps = _rateBps;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(msg.sender, (amountIn * rateBps) / 10_000);
    }
}
