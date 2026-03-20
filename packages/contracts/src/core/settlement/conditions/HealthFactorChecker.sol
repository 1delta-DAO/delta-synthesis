// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

/**
 * @title HealthFactorChecker
 * @notice Per-lender health factor verification for post-settlement conditions.
 *         Ensures a user's lending position stays above a signed minimum health
 *         factor after all settlement actions complete.
 *
 * @dev Aave V2 / V3:
 *      getUserAccountData(address) ->
 *
 *        (uint256 totalCollateralBase,
 *         uint256 totalDebtBase,
 *         uint256 availableBorrowsBase,
 *         uint256 currentLiquidationThreshold,
 *         uint256 ltv,
 *         uint256 healthFactor)           ← 6th slot, offset 0xA0
 *
 *      healthFactor uses 18 decimals (1e18 = 1.0).
 *      When the user has no debt, healthFactor = type(uint256).max.
 *
 *      Morpho Blue:
 *      Per-market isolated health factor computed from on-chain state:
 *
 *        1. position(marketId, user)     → (supplyShares, borrowShares, collateral)
 *        2. idToMarketParams(marketId)   → (loanToken, collateralToken, oracle, irm, lltv)
 *        3. market(marketId)             → (totalSupplyAssets, totalSupplyShares,
 *                                           totalBorrowAssets, totalBorrowShares, ...)
 *        4. IOracle(oracle).price()      → collateralPrice (scaled 1e36)
 *
 *        borrowed    = mulDivUp(borrowShares, totalBorrowAssets + 1, totalBorrowShares + 1e6)
 *        maxBorrow   = collateral * collateralPrice / 1e36 * lltv / 1e18
 *        healthFactor = maxBorrow * 1e18 / borrowed
 *
 *      When borrowShares == 0, the position is healthy (no debt).
 *
 *      Compound V3 (Comet):
 *      No aggregate health factor. Computed from user-specified collateral assets via bitmap:
 *
 *        borrowValue = borrowBalanceOf(user) * getPrice(baseTokenPriceFeed) / baseScale
 *        collValue   = sum over i in assetBitmap: balance_i * getPrice(priceFeed_i) / scale_i * liquidateCF_i / 1e18
 *        healthFactor = collValue * 1e18 / borrowValue
 *
 *      The assetBitmap (uint16) selects which asset indices to check, avoiding
 *      iteration over all Comet assets (e.g. 13 on USDC Comet).
 *      When borrowBalanceOf(user) == 0, the position is healthy (no debt).
 *
 *      Compound V2 (and forks):
 *      Binary solvency check via the Comptroller. Computing an exact numeric health
 *      factor would require iterating all entered markets; instead we use:
 *
 *        Comptroller.getAccountLiquidity(user) → (error, liquidity, shortfall)
 *        Reverts if error != 0 || shortfall > 0.
 *
 *      This is equivalent to HF >= 1.0. The minHealthFactor parameter in the
 *      condition data is reserved for forward compatibility but not used for
 *      fine-grained thresholds.
 */
abstract contract HealthFactorChecker {
    error HealthFactorTooLow();

    /// @dev HealthFactorTooLow()
    bytes4 private constant _HF_TOO_LOW = 0x62e82dca;

    /**
     * @notice Reverts if the user's Aave health factor is below `minHealthFactor`.
     *         Works for both Aave V2 and V3 (same getUserAccountData interface).
     * @param pool             The Aave lending pool address
     * @param user             The position owner
     * @param minHealthFactor  Minimum acceptable health factor (18 decimals)
     */
    function _checkAaveHealthFactor(
        address pool,
        address user,
        uint256 minHealthFactor
    ) internal view {
        assembly {
            let ptr := mload(0x40)

            // getUserAccountData(address) selector: 0xbf92857c
            mstore(ptr, 0xbf92857c00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), user)

            // staticcall — returns 6 × 32 = 192 bytes (0xC0)
            if iszero(staticcall(gas(), pool, ptr, 0x24, ptr, 0xC0)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }

            // skip to healthFactor at offset 0xA0
            let hf := mload(add(ptr, 0xA0))

            if lt(hf, minHealthFactor) {
                mstore(0x00, _HF_TOO_LOW)
                revert(0x00, 0x04)
            }
        }
    }

    /**
     * @notice Reverts if the user's Morpho Blue market health factor is below `minHealthFactor`.
     *         Fetches all required data on-chain from the marketId alone.
     *
     * @dev STALENESS NOTE: market() returns totalBorrowAssets/totalBorrowShares as of the
     *      last interaction (lastUpdate). Unaccrued interest since then causes the checker to
     *      *overestimate* health factor (borrowed appears smaller than reality). In practice
     *      this is negligible for recently-active markets, but for low-activity markets the
     *      user should factor in a safety margin when choosing minHealthFactor. A precise
     *      alternative would be to replicate Morpho's linear interest accrual inline, but
     *      this would require an additional IRM call and ~200 gas of math.
     *
     * @param morpho           The Morpho Blue contract address
     * @param marketId         The Morpho Blue market identifier
     * @param user             The position owner
     * @param minHealthFactor  Minimum acceptable health factor (18 decimals)
     */
    function _checkMorphoHealthFactor(
        address morpho,
        bytes32 marketId,
        address user,
        uint256 minHealthFactor
    ) internal view {
        assembly {
            let ptr := mload(0x40)

            // 1. position(marketId, user) → (supplyShares, borrowShares, collateral)
            mstore(ptr, 0x93c5206200000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), marketId)
            mstore(add(ptr, 0x24), user)
            if iszero(staticcall(gas(), morpho, ptr, 0x44, ptr, 0x60)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            let borrowShares := mload(add(ptr, 0x20))
            let collateral := mload(add(ptr, 0x40))

            // No debt → healthy, skip remaining checks
            if borrowShares {
                // 2. idToMarketParams(marketId) → (loanToken, collateralToken, oracle, irm, lltv)
                mstore(ptr, 0x2c3c915700000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), marketId)
                if iszero(staticcall(gas(), morpho, ptr, 0x24, ptr, 0xA0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                let oracle := mload(add(ptr, 0x40))
                let lltv := mload(add(ptr, 0x80))

                // 3. market(marketId) → (..., totalBorrowAssets, totalBorrowShares, ...)
                mstore(ptr, 0x5c60e39a00000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), marketId)
                if iszero(staticcall(gas(), morpho, ptr, 0x24, ptr, 0xC0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                let totalBorrowAssets := mload(add(ptr, 0x40))
                let totalBorrowShares := mload(add(ptr, 0x60))

                // 4. borrowed = mulDivUp(borrowShares, totalBorrowAssets + 1, totalBorrowShares + 1e6)
                let denom := add(totalBorrowShares, 1000000)
                let borrowed := div(
                    add(mul(borrowShares, add(totalBorrowAssets, 1)), sub(denom, 1)),
                    denom
                )

                // 5. IOracle(oracle).price() → collateralPrice (scaled 1e36)
                mstore(ptr, 0xa035b1fe00000000000000000000000000000000000000000000000000000000)
                if iszero(staticcall(gas(), oracle, ptr, 0x04, ptr, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                let collateralPrice := mload(ptr)

                // 6. maxBorrow = collateral * collateralPrice / 1e36 * lltv / 1e18
                let collValue := div(mul(collateral, collateralPrice), 0xc097ce7bc90715b34b9f1000000000)
                let maxBorrow := div(mul(collValue, lltv), 0xde0b6b3a7640000)

                // 7. Overflow-safe check: maxBorrow * 1e18 >= borrowed * minHealthFactor
                //    LHS cannot overflow (maxBorrow bounded by uint128 collateral / 1e54).
                //    RHS can overflow for extreme borrow * minHF products.
                if minHealthFactor {
                    if gt(borrowed, div(not(0), minHealthFactor)) {
                        mstore(0x00, _HF_TOO_LOW)
                        revert(0x00, 0x04)
                    }
                }
                if lt(
                    mul(maxBorrow, 0xde0b6b3a7640000),
                    mul(borrowed, minHealthFactor)
                ) {
                    mstore(0x00, _HF_TOO_LOW)
                    revert(0x00, 0x04)
                }
            }
        }
    }

    /**
     * @notice Reverts if the user's Compound V3 Comet health factor is below `minHealthFactor`.
     *         Only checks collateral assets whose indices are set in `assetBitmap` (uint16),
     *         avoiding iteration over all Comet assets.
     * @param comet            The Comet contract address
     * @param user             The position owner
     * @param assetBitmap      Bitmap of asset indices to check (bit i = asset index i)
     * @param minHealthFactor  Minimum acceptable health factor (18 decimals)
     */
    function _checkCompoundV3HealthFactor(
        address comet,
        address user,
        uint256 assetBitmap,
        uint256 minHealthFactor
    ) internal view {
        assembly {
            let ptr := mload(0x40)

            // 1. borrowBalanceOf(user)
            mstore(ptr, 0x374c49b400000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), user)
            if iszero(staticcall(gas(), comet, ptr, 0x24, ptr, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            let borrowBal := mload(ptr)

            if borrowBal {
            // 2. baseTokenPriceFeed()
            mstore(ptr, 0xe7dad6bd00000000000000000000000000000000000000000000000000000000)
            if iszero(staticcall(gas(), comet, ptr, 0x04, ptr, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            let baseFeed := mload(ptr)

            // 3. baseScale()
            mstore(ptr, 0x44c1e5eb00000000000000000000000000000000000000000000000000000000)
            if iszero(staticcall(gas(), comet, ptr, 0x04, ptr, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            let bScale := mload(ptr)

            // 4. getPrice(baseFeed)
            mstore(ptr, 0x41976e0900000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), baseFeed)
            if iszero(staticcall(gas(), comet, ptr, 0x24, ptr, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            let basePrice := mload(ptr)

            // 5. borrowValue = borrowBal * basePrice / bScale
            let borrowValue := div(mul(borrowBal, basePrice), bScale)

            // 6. Iterate only asset indices whose bits are set in assetBitmap
            let collValue := 0
            let bitmap := and(assetBitmap, 0xffff)

            for { let i := 0 } lt(i, 16) { i := add(i, 1) } {
                if iszero(and(bitmap, shl(i, 1))) { continue }

                // 6a. getAssetInfo(i) -> 256 bytes
                mstore(ptr, 0xc8c7fe6b00000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), i)
                if iszero(staticcall(gas(), comet, ptr, 0x24, ptr, 0x100)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                let asset := mload(add(ptr, 0x20))
                let priceFeed := mload(add(ptr, 0x40))
                let scale := mload(add(ptr, 0x60))
                let liquidateCF := mload(add(ptr, 0xA0))

                // 6b. userCollateral(user, asset)
                mstore(ptr, 0x2b92a07d00000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), user)
                mstore(add(ptr, 0x24), asset)
                if iszero(staticcall(gas(), comet, ptr, 0x44, ptr, 0x40)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                let collBal := mload(ptr)

                if collBal {
                    // 6c. getPrice(priceFeed)
                    mstore(ptr, 0x41976e0900000000000000000000000000000000000000000000000000000000)
                    mstore(add(ptr, 0x04), priceFeed)
                    if iszero(staticcall(gas(), comet, ptr, 0x24, ptr, 0x20)) {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    let price := mload(ptr)

                    // weighted = collBal * price * liquidateCF / (scale * 1e18)
                    let weighted := div(mul(mul(collBal, price), liquidateCF), mul(scale, 0xde0b6b3a7640000))
                    collValue := add(collValue, weighted)
                }
            }

            // 7. Overflow-safe check: collValue * 1e18 >= borrowValue * minHealthFactor
            //    RHS can overflow for large borrow positions with high minHF.
            if minHealthFactor {
                if gt(borrowValue, div(not(0), minHealthFactor)) {
                    mstore(0x00, _HF_TOO_LOW)
                    revert(0x00, 0x04)
                }
            }
            if lt(mul(collValue, 0xde0b6b3a7640000), mul(borrowValue, minHealthFactor)) {
                mstore(0x00, _HF_TOO_LOW)
                revert(0x00, 0x04)
            }
            }
        }
    }

    /**
     * @notice Reverts if the user's Compound V2 position is insolvent.
     *         Uses Comptroller.getAccountLiquidity for a binary solvency check (HF >= 1.0).
     *         Computing an exact numeric health factor would require iterating all entered
     *         markets, which is prohibitively expensive with unknown iteration count.
     * @param comptroller  The Comptroller contract address
     * @param user         The position owner
     */
    function _checkCompoundV2Solvency(
        address comptroller,
        address user
    ) internal view {
        assembly {
            let ptr := mload(0x40)

            // getAccountLiquidity(address) → (uint error, uint liquidity, uint shortfall)
            // selector: 0x5ec88c79
            mstore(ptr, 0x5ec88c7900000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), user)

            if iszero(staticcall(gas(), comptroller, ptr, 0x24, ptr, 0x60)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }

            let err := mload(ptr)
            let shortfall := mload(add(ptr, 0x40))

            // error != 0 or shortfall > 0 → position is insolvent
            if or(err, shortfall) {
                mstore(0x00, _HF_TOO_LOW)
                revert(0x00, 0x04)
            }
        }
    }

}
