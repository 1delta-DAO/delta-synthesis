// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

/**
 * @title ISettlementPriceOracle
 * @notice Minimal oracle interface for settlement swap verification.
 *         Implementations can wrap Chainlink, Pyth, Uniswap TWAP, or any
 *         other price source.
 *
 * @dev The oracle must return the expected output amount for a given input,
 *      handling all decimal conversions internally.  For example, for a
 *      WETH → USDC query with amountIn = 1e18 (1 WETH) at price $3000,
 *      the oracle returns 3000e6 (3000 USDC).
 */
interface ISettlementPriceOracle {
    /**
     * @notice Get the expected output amount at the current oracle price.
     * @param assetIn  Input token address.
     * @param assetOut Output token address.
     * @param amountIn Input amount (in assetIn's native decimals).
     * @return expectedOut Expected output amount (in assetOut's native decimals).
     */
    function getExpectedOutput(
        address assetIn,
        address assetOut,
        uint256 amountIn
    ) external view returns (uint256 expectedOut);
}
