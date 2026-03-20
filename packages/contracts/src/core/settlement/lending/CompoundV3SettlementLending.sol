// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {ERC20Selectors} from "../../selectors/ERC20Selectors.sol";
import {Masks} from "../../masks/Masks.sol";

// solhint-disable max-line-length

/**
 * @title CompoundV3SettlementLending
 * @notice Settlement lending module for Compound V3 (Comet) protocol.
 * @dev Provides low-level assembly interactions for deposit, withdraw, borrow, and repay
 *      operations on Compound V3 Comet markets. Compound V3 unifies lending and borrowing
 *      into a single Comet contract per market.
 *
 *      Supported operations:
 *        - Withdraw:  Calls comet.withdrawFrom() on behalf of caller. Supports both base asset
 *                     (via balanceOf) and collateral asset (via userCollateral) for max amount
 *        - Borrow:    Calls comet.withdrawFrom() (borrowing in V3 is a withdraw of the base asset)
 *        - Deposit:   Calls comet.supplyTo() to supply assets on behalf of receiver
 *        - Repay:     Calls comet.supplyTo() (repaying in V3 is a supply of the base asset).
 *                     Safe max repay uses borrowBalanceOf() to cap the amount
 *
 *      Amount semantics:
 *        - 0:                       Use contract's current balance of the asset
 *        - type(uint112).max:       Use caller's full balance (base via balanceOf, collateral via userCollateral)
 *        - any other value:         Use as-is
 *
 *      Data layout: [1: isBase][20: comet] for withdraw, [20: comet] for borrow/deposit/repay
 */
abstract contract CompoundV3SettlementLending is ERC20Selectors, Masks {
    /**
     * @notice Withdraws from Compound V3 lending pool
     * @param asset The underlying token address
     * @param amount The amount to withdraw (type(uint112).max = user's full balance)
     * @param receiver The address to receive withdrawn tokens
     * @param orderSigner Address of the caller
     * @param data Lender-specific data: [1: isBase][20: comet]
     */
    function _withdrawFromCompoundV3(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptr := mload(0x40)
            let d := add(data, 0x20)

            let isBase := shr(248, mload(d))
            let cometPool := shr(96, mload(add(d, 1)))

            if eq(amount, 0xffffffffffffffffffffffffffff) {
                switch isBase
                case 0 {
                    // userCollateral(address,address)
                    mstore(ptr, 0x2b92a07d00000000000000000000000000000000000000000000000000000000)
                    mstore(add(ptr, 0x04), orderSigner)
                    mstore(add(ptr, 0x24), asset)
                    if iszero(staticcall(gas(), cometPool, ptr, 0x44, ptr, 0x20)) {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    amount := and(UINT128_MASK, mload(ptr))
                }
                default {
                    mstore(0, ERC20_BALANCE_OF)
                    mstore(0x04, orderSigner)
                    if iszero(staticcall(gas(), cometPool, 0x0, 0x24, 0x0, 0x20)) {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    amount := mload(0x0)
                }
            }

            // withdrawFrom(address,address,address,uint256)
            mstore(ptr, 0x2644131800000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), orderSigner)
            mstore(add(ptr, 0x24), receiver)
            mstore(add(ptr, 0x44), asset)
            mstore(add(ptr, 0x64), amount)
            if iszero(call(gas(), cometPool, 0x0, ptr, 0x84, 0x0, 0x0)) {
                returndatacopy(0x0, 0x0, returndatasize())
                revert(0x0, returndatasize())
            }

            amountOut := amount
        }
    }

    /**
     * @notice Borrows from Compound V3 lending pool
     * @param asset The underlying token address to borrow
     * @param amount The amount to borrow
     * @param receiver The address to receive borrowed tokens
     * @param orderSigner Address of the caller
     * @param data Lender-specific data: [20: comet]
     */
    function _borrowFromCompoundV3(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptr := mload(0x40)
            let cometPool := shr(96, mload(add(data, 0x20)))

            // withdrawFrom(address,address,address,uint256)
            mstore(ptr, 0x2644131800000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), orderSigner)
            mstore(add(ptr, 0x24), receiver)
            mstore(add(ptr, 0x44), asset)
            mstore(add(ptr, 0x64), amount)
            if iszero(call(gas(), cometPool, 0x0, ptr, 0x84, 0x0, 0x0)) {
                returndatacopy(0x0, 0x0, returndatasize())
                revert(0x0, returndatasize())
            }

            amountOut := amount
        }
    }

    /**
     * @notice Deposits to Compound V3 lending pool
     * @param asset The underlying token address to deposit
     * @param amount The amount to deposit (0 = contract balance)
     * @param receiver The address to receive cTokens
     * @param data Lender-specific data: [20: comet]
     */
    function _depositToCompoundV3(
        address asset,
        uint256 amount,
        address receiver,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let comet := shr(96, mload(add(data, 0x20)))

            if iszero(amount) {
                mstore(0, ERC20_BALANCE_OF)
                mstore(0x04, address())
                if iszero(staticcall(gas(), asset, 0x0, 0x24, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                amount := mload(0x0)
            }

            if amount {
                let ptr := mload(0x40)
                // supplyTo(address,address,uint256)
                mstore(ptr, 0x4232cd6300000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), receiver)
                mstore(add(ptr, 0x24), asset)
                mstore(add(ptr, 0x44), amount)
                if iszero(call(gas(), comet, 0x0, ptr, 0x64, 0x0, 0x0)) {
                    returndatacopy(0x0, 0x0, returndatasize())
                    revert(0x0, returndatasize())
                }

                amountIn := amount
            }
        }
    }

    /**
     * @notice Repays debt to Compound V3 lending pool
     * @param asset The underlying token address to repay
     * @param amount The amount to repay (0 = contract balance, type(uint112).max = safe max)
     * @param receiver The borrower address (on behalf of)
     * @param data Lender-specific data: [20: comet]
     */
    function _repayToCompoundV3(
        address asset,
        uint256 amount,
        address receiver,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let comet := shr(96, mload(add(data, 0x20)))

            switch amount
            case 0 {
                mstore(0, ERC20_BALANCE_OF)
                mstore(0x04, address())
                if iszero(staticcall(gas(), asset, 0x0, 0x24, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                amount := mload(0x0)
            }
            case 0xffffffffffffffffffffffffffff {
                mstore(0, ERC20_BALANCE_OF)
                mstore(0x04, address())
                if iszero(staticcall(gas(), asset, 0x0, 0x24, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                amount := mload(0x0)

                // borrowBalanceOf(address)
                mstore(0, 0x374c49b400000000000000000000000000000000000000000000000000000000)
                mstore(0x04, receiver)
                if iszero(staticcall(gas(), comet, 0x0, 0x24, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                let userBorrowBalance := mload(0x0)
                if gt(amount, userBorrowBalance) { amount := userBorrowBalance }
            }

            let ptr := mload(0x40)
            // supplyTo(address,address,uint256)
            mstore(ptr, 0x4232cd6300000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), receiver)
            mstore(add(ptr, 0x24), asset)
            mstore(add(ptr, 0x44), amount)
            if iszero(call(gas(), comet, 0x0, ptr, 0x64, 0x0, 0x0)) {
                returndatacopy(0x0, 0x0, returndatasize())
                revert(0x0, returndatasize())
            }

            amountIn := amount
        }
    }
}
