// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {ISettlementPriceOracle} from "./ISettlementPriceOracle.sol";

/**
 * @title SwapVerifier
 * @notice Verifies that a swap execution produced an output amount within
 *         the user's signed tolerance of the oracle price.
 *
 * @dev The user signs a `swapTolerance` per conversion — the maximum
 *      downward adjustment from the oracle price they will accept.
 *      This gives the solver room to fill at slightly worse-than-oracle
 *      rates (DEX fees, MEV, price movement) while still protecting the user.
 *
 *      Uses the same 1e7 denominator as the fee system:
 *
 *        1e7 = 100%  |  100 000 = 1%  |  1 000 = 1 bps  |  10 = 0.01 bps
 *
 *      Verification:
 *
 *        minAcceptable = oracleOutput × (1 − swapTolerance / 1e7)
 *        require(amountOut >= minAcceptable)
 *
 *      Rearranged to avoid division:
 *
 *        amountOut × 1e7  ≥  oracleOutput × (1e7 − swapTolerance)
 *
 *      Example: swapTolerance = 30 000 (0.3%), oracle says 1 WETH = 3000 USDC
 *        minAcceptable = 3000 × (1 − 0.003) = 2991 USDC
 *        solver delivers 2995 USDC → passes ✓
 *        solver delivers 2990 USDC → reverts ✗
 */
abstract contract SwapVerifier {
    /// @dev Swap output is below the oracle price minus the user's tolerance.
    error SlippageExceeded();

    /// @dev 100% = 1e7, matching the fee denominator.
    uint256 private constant SWAP_DENOMINATOR = 1e7;

    /**
     * @notice Verify a swap output against an oracle price with user tolerance.
     * @param oracle         Oracle that returns expected output for the pair.
     * @param assetIn        Input token.
     * @param assetOut       Output token.
     * @param amountIn       Actual input amount.
     * @param amountOut      Actual output amount received from the swap.
     * @param swapTolerance  User-signed downward tolerance (1e7 denominator).
     *                       E.g. 30 000 = 0.3% below oracle is acceptable.
     */
    function _verifySwapOutput(
        address oracle,
        address assetIn,
        address assetOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 swapTolerance
    ) internal view {
        uint256 expectedOut = ISettlementPriceOracle(oracle).getExpectedOutput(assetIn, assetOut, amountIn);

        // amountOut >= expectedOut × (1 − tolerance)
        // amountOut × DENOMINATOR >= expectedOut × (DENOMINATOR − swapTolerance)
        if (amountOut * SWAP_DENOMINATOR < expectedOut * (SWAP_DENOMINATOR - swapTolerance)) {
            revert SlippageExceeded();
        }
    }
}
