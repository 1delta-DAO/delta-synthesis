// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {ISwapRouter} from "../../src/interfaces/ISwapRouter.sol";
import {IERC20} from "lib/forge-std/src/interfaces/IERC20.sol";

/// @notice Mock Uniswap V3 SwapRouter for testing.
///         Uses a fixed exchange rate instead of actual pool logic.
contract MockSwapRouter is ISwapRouter {
    /// @notice Fixed rate: amountOut = amountIn * rate / 1e18
    uint256 public rate;

    error SlippageExceeded();

    constructor(uint256 _rate) {
        rate = _rate;
    }

    function setRate(uint256 _rate) external {
        rate = _rate;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        amountOut = (params.amountIn * rate) / 1e18;
        if (amountOut < params.amountOutMinimum) revert SlippageExceeded();

        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}
