// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {AaveSettlementLending} from "./AaveSettlementLending.sol";
import {CompoundV3SettlementLending} from "./CompoundV3SettlementLending.sol";
import {CompoundV2SettlementLending} from "./CompoundV2SettlementLending.sol";
import {MorphoSettlementLending} from "./MorphoSettlementLending.sol";
import {LenderIds, LenderOps} from "./DeltaEnums.sol";
import {DeltaErrors} from "../../errors/Errors.sol";

// solhint-disable max-line-length

/**
 * @title UniversalSettlementLending
 * @notice Unified lending router — single entry point for all protocol interactions
 *         during settlement.  Dispatches by (lendingOperation, lender) and returns
 *         the asset address + signed amounts for zero-sum delta accounting.
 *
 * @dev Protocol routing (LenderIds thresholds — exclusive upper bounds):
 *
 *        lender <  1 000  →  Aave V3
 *        lender <  2 000  →  Aave V2
 *        lender <  3 000  →  Compound V3
 *        lender <  4 000  →  Compound V2
 *        lender <  5 000  →  Morpho Blue
 *
 *      Operations (LenderOps):
 *
 *        0  DEPOSIT               — deposit collateral
 *        1  BORROW                — borrow assets
 *        2  REPAY                 — repay debt
 *        3  WITHDRAW              — withdraw collateral
 *        4  DEPOSIT_LENDING_TOKEN — Morpho-only: supply loan token
 *        5  WITHDRAW_LENDING_TOKEN— Morpho-only: withdraw loan token
 *
 *      Return layout  (address assetUsed, uint256 amountIn, uint256 amountOut):
 *
 *        • assetUsed — The ERC-20 token the operation moved.  Set at the router
 *          level to the `asset` parameter, making delta accounting self-verifying:
 *          the executor tracks what the lending stack ACTUALLY touched, not what
 *          the solver declared.
 *
 *        • amountIn  — Resolved tokens the contract sent to the protocol.
 *          Non-zero for DEPOSIT / REPAY / DEPOSIT_LENDING_TOKEN.
 *
 *        • amountOut — Resolved tokens the contract received from the protocol.
 *          Non-zero for WITHDRAW / BORROW / WITHDRAW_LENDING_TOKEN.
 *
 *      "Resolved" means sentinel values (0 → balance, type(uint112).max → safe
 *      max) have been replaced with the concrete amount that was actually moved.
 */
abstract contract UniversalSettlementLending is
    AaveSettlementLending,
    CompoundV3SettlementLending,
    CompoundV2SettlementLending,
    MorphoSettlementLending,
    DeltaErrors
{
    /**
     * @notice Executes any lending operation across various lenders
     * @param orderSigner Address of the caller
     * @param asset The token address for the lending operation
     * @param amount The amount for the lending operation (0 = contract balance, type(uint112).max = max/safe max)
     * @param receiver The receiver address
     * @param lendingOperation The lending operation type (from LenderOps)
     * @param lender The lender identifier (from LenderIds)
     * @param data Lender-specific data blob (bytes memory)
     * @return assetUsed The actual token address operated on (for delta accounting)
     * @return amountIn The resolved amount paid/consumed (deposit, repay) or 0 (withdraw, borrow)
     * @return amountOut The resolved amount received/withdrawn (withdraw, borrow) or 0 (deposit, repay)
     */
    function _lendingOperations(
        address orderSigner,
        address asset,
        uint256 amount,
        address receiver,
        uint256 lendingOperation,
        uint256 lender,
        bytes memory data
    )
        internal
        virtual
        returns (address assetUsed, uint256 amountIn, uint256 amountOut)
    {
        assetUsed = asset;

        /**
         * Deposit collateral
         */
        if (lendingOperation == LenderOps.DEPOSIT) {
            if (lender < LenderIds.UP_TO_AAVE_V3) {
                (amountIn, amountOut) = _depositToAaveV3(asset, amount, receiver, data);
            } else if (lender < LenderIds.UP_TO_AAVE_V2) {
                (amountIn, amountOut) = _depositToAaveV2(asset, amount, receiver, data);
            } else if (lender < LenderIds.UP_TO_COMPOUND_V3) {
                (amountIn, amountOut) = _depositToCompoundV3(asset, amount, receiver, data);
            } else if (lender < LenderIds.UP_TO_COMPOUND_V2) {
                (amountIn, amountOut) = _depositToCompoundV2(asset, amount, receiver, data);
            } else if (lender < LenderIds.UP_TO_MORPHO) {
                (amountIn, amountOut) = _encodeMorphoDepositCollateral(asset, amount, receiver, orderSigner, data);
            } else {
                _invalidOperation();
            }
        }
        /**
         * Borrow
         */
        else if (lendingOperation == LenderOps.BORROW) {
            if (lender < LenderIds.UP_TO_AAVE_V2) {
                (amountIn, amountOut) = _borrowFromAave(asset, amount, receiver, orderSigner, data);
            } else if (lender < LenderIds.UP_TO_COMPOUND_V3) {
                (amountIn, amountOut) = _borrowFromCompoundV3(asset, amount, receiver, orderSigner, data);
            } else if (lender < LenderIds.UP_TO_COMPOUND_V2) {
                (amountIn, amountOut) = _borrowFromCompoundV2(asset, amount, receiver, orderSigner, data);
            } else if (lender < LenderIds.UP_TO_MORPHO) {
                (amountIn, amountOut) = _morphoBorrow(asset, amount, receiver, orderSigner, data);
            } else {
                _invalidOperation();
            }
        }
        /**
         * Repay
         */
        else if (lendingOperation == LenderOps.REPAY) {
            if (lender < LenderIds.UP_TO_AAVE_V2) {
                (amountIn, amountOut) = _repayToAave(asset, amount, receiver, data);
            } else if (lender < LenderIds.UP_TO_COMPOUND_V3) {
                (amountIn, amountOut) = _repayToCompoundV3(asset, amount, receiver, data);
            } else if (lender < LenderIds.UP_TO_COMPOUND_V2) {
                (amountIn, amountOut) = _repayToCompoundV2(asset, amount, receiver, data);
            } else if (lender < LenderIds.UP_TO_MORPHO) {
                (amountIn, amountOut) = _morphoRepay(asset, amount, receiver, orderSigner, data);
            } else {
                _invalidOperation();
            }
        }
        /**
         * Withdraw collateral
         */
        else if (lendingOperation == LenderOps.WITHDRAW) {
            if (lender < LenderIds.UP_TO_AAVE_V2) {
                (amountIn, amountOut) = _withdrawFromAave(asset, amount, receiver, orderSigner, data);
            } else if (lender < LenderIds.UP_TO_COMPOUND_V3) {
                (amountIn, amountOut) = _withdrawFromCompoundV3(asset, amount, receiver, orderSigner, data);
            } else if (lender < LenderIds.UP_TO_COMPOUND_V2) {
                (amountIn, amountOut) = _withdrawFromCompoundV2(asset, amount, receiver, orderSigner, data);
            } else if (lender < LenderIds.UP_TO_MORPHO) {
                (amountIn, amountOut) = _encodeMorphoWithdrawCollateral(asset, amount, receiver, orderSigner, data);
            } else {
                _invalidOperation();
            }
        }
        /**
         * deposit lendingToken
         */
        else if (lendingOperation == LenderOps.DEPOSIT_LENDING_TOKEN) {
            (amountIn, amountOut) = _encodeMorphoDeposit(asset, amount, receiver, orderSigner, data);
        }
        /**
         * withdraw lendingToken
         */
        else if (lendingOperation == LenderOps.WITHDRAW_LENDING_TOKEN) {
            (amountIn, amountOut) = _encodeMorphoWithdraw(asset, amount, receiver, orderSigner, data);
        } else {
            _invalidOperation();
        }
    }
}
