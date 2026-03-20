// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {ISettlementPriceOracle} from "./ISettlementPriceOracle.sol";

/**
 * @title IAaveOracle
 * @notice Minimal interface for the Aave V3 price oracle.
 *         Returns asset prices in USD with 8 decimals.
 */
interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

/**
 * @title IERC20Decimals
 */
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/**
 * @title AaveOracleAdapter
 * @notice Wraps an Aave V3 price oracle to implement the ISettlementPriceOracle
 *         interface.  Converts between any two assets priced by the oracle,
 *         handling decimal normalization automatically.
 *
 * @dev The Aave oracle returns USD prices with 8 decimals for all assets.
 *      To compute expectedOut for a swap of assetIn → assetOut:
 *
 *        priceIn  = oracle.getAssetPrice(assetIn)    // USD per assetIn unit, 8 dec
 *        priceOut = oracle.getAssetPrice(assetOut)   // USD per assetOut unit, 8 dec
 *
 *        expectedOut = amountIn × priceIn / priceOut
 *                      × 10^decimalsOut / 10^decimalsIn
 *
 *      Example: 1 WETH (18 dec) → USDC (6 dec) at ETH=$2344
 *        priceIn  = 234400000000  (2344e8)
 *        priceOut = 100000000     (1e8)
 *        expectedOut = 1e18 × 2344e8 / 1e8 × 1e6 / 1e18
 *                    = 1e18 × 2344 × 1e6 / 1e18
 *                    = 2344e6  ✓
 */
contract AaveOracleAdapter is ISettlementPriceOracle {
    IAaveOracle public immutable aaveOracle;

    constructor(address _aaveOracle) {
        aaveOracle = IAaveOracle(_aaveOracle);
    }

    /**
     * @notice Get expected output amount using Aave oracle prices.
     * @param assetIn  Input token (must be listed on the Aave oracle).
     * @param assetOut Output token (must be listed on the Aave oracle).
     * @param amountIn Input amount in assetIn's native decimals.
     * @return expectedOut Output amount in assetOut's native decimals.
     */
    function getExpectedOutput(
        address assetIn,
        address assetOut,
        uint256 amountIn
    ) external view override returns (uint256 expectedOut) {
        uint256 priceIn = aaveOracle.getAssetPrice(assetIn);
        uint256 priceOut = aaveOracle.getAssetPrice(assetOut);

        uint8 decimalsIn = IERC20Decimals(assetIn).decimals();
        uint8 decimalsOut = IERC20Decimals(assetOut).decimals();

        // expectedOut = amountIn × priceIn × 10^decimalsOut / (priceOut × 10^decimalsIn)
        expectedOut = (amountIn * priceIn * (10 ** decimalsOut)) / (priceOut * (10 ** decimalsIn));
    }
}
