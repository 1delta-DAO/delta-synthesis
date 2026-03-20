// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {ERC20Selectors} from "../../selectors/ERC20Selectors.sol";
import {Masks} from "../../masks/Masks.sol";

// solhint-disable max-line-length

/**
 * @title CompoundV2SettlementLending
 * @notice Settlement lending module for Compound V2 and compatible forks (e.g. Venus, Iron Bank, dForce iTokens).
 * @dev Provides low-level assembly interactions for deposit, withdraw, borrow, and repay
 *      operations on Compound V2-style cToken markets. Supports multiple mint/redeem selector
 *      variants via a `selectorId` byte to accommodate protocol forks with different function signatures.
 *
 *      Supported operations:
 *        - Borrow:    Calls cToken.borrowBehalf(), optionally forwards tokens to receiver
 *        - Withdraw:  Converts underlying amount to cToken shares via exchangeRateCurrent(),
 *                     then redeems via redeem/redeemBehalf/redeem(address,uint) depending on selectorId
 *        - Deposit:   Mints cTokens via mintBehalf/mint(uint)/mint(address,uint) depending on selectorId.
 *                     Handles native ETH deposits (cETH) with value-bearing calls
 *        - Repay:     Calls repayBorrowBehalf() for both native and ERC20 assets
 *
 *      Amount semantics:
 *        - 0:                       Use contract's current balance (or selfbalance() for native)
 *        - type(uint112).max:       Use caller's full balance (max withdraw via balanceOfUnderlying, safe max repay via borrowBalanceCurrent)
 *        - any other value:         Use as-is
 *
 *      selectorId variants (for deposit/withdraw):
 *        - 0: mintBehalf / transferFrom+redeem (standard Compound V2)
 *        - 1: mint(uint) / redeemBehalf (forks with behalf support)
 *        - 2: mint(address,uint) / redeem(address,uint) (iToken-style forks like dForce)
 */
abstract contract CompoundV2SettlementLending is ERC20Selectors, Masks {
    // NativeTransferFailed()
    bytes4 private constant NATIVE_TRANSFER_FAILED = 0xf4b3b1bc;

    /**
     * @notice Borrows from Compound V2 lending pool
     * @param asset The underlying token address
     * @param amount The amount to borrow
     * @param receiver The address to receive borrowed tokens
     * @param orderSigner Address of the caller
     * @param data Lender-specific data: [20: cToken]
     */
    function _borrowFromCompoundV2(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptr := mload(0x40)
            let cToken := shr(96, mload(add(data, 0x20)))

            // borrowBehalf(address,uint256)
            mstore(ptr, 0x856e5bb300000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x4), orderSigner)
            mstore(add(ptr, 0x24), amount)
            if iszero(call(gas(), cToken, 0x0, ptr, 0x44, 0x0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            let rdsize := returndatasize()
            if and(eq(rdsize, 1), xor(mload(0x0), 0)) {
                returndatacopy(0, 0, rdsize)
                revert(0, rdsize)
            }
            if xor(address(), receiver) {
                if iszero(asset) { revert(0, 0) }

                mstore(ptr, ERC20_TRANSFER)
                mstore(add(ptr, 0x04), receiver)
                mstore(add(ptr, 0x24), amount)

                let success := call(gas(), asset, 0, ptr, 0x44, ptr, 32)
                rdsize := returndatasize()
                success := and(
                    success,
                    or(iszero(rdsize), and(gt(rdsize, 31), eq(mload(ptr), 1)))
                )
                if iszero(success) {
                    returndatacopy(0, 0, rdsize)
                    revert(0, rdsize)
                }
            }

            amountOut := amount
        }
    }

    /**
     * @notice Withdraws from Compound V2 lending pool
     * @param asset The underlying token address
     * @param amount The amount to withdraw (type(uint112).max = user's full balance)
     * @param receiver The address to receive withdrawn tokens
     * @param orderSigner Address of the caller
     * @param data Lender-specific data: [1: selectorId][20: cToken]
     */
    function _withdrawFromCompoundV2(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptr := mload(0x40)
            let d := add(data, 0x20)

            let selectorId := shr(248, mload(d))
            let cToken := shr(96, mload(add(d, 1)))

            if eq(amount, 0xffffffffffffffffffffffffffff) {
                // balanceOfUnderlying(address)
                mstore(0, 0x3af9e66900000000000000000000000000000000000000000000000000000000)
                mstore(0x04, orderSigner)
                pop(call(gas(), cToken, 0x0, 0x0, 0x24, 0x0, 0x20))
                amount := mload(0x0)
            }

            // exchangeRateCurrent()
            mstore(0x0, 0xbd6d894d00000000000000000000000000000000000000000000000000000000)
            pop(call(gas(), cToken, 0x0, 0x0, 0x24, 0x0, 0x20))
            let refAmount := mload(0x0)

            let cTokenTransferAmount :=
                add(
                    div(mul(amount, 1000000000000000000), refAmount),
                    1
                )

            mstore(0x0, ERC20_BALANCE_OF)
            mstore(0x4, orderSigner)
            if iszero(staticcall(gas(), cToken, 0x0, 0x24, 0x0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            refAmount := mload(0x0)
            if gt(cTokenTransferAmount, refAmount) { cTokenTransferAmount := refAmount }

            switch selectorId
            case 0 {
                // transferFrom(address,address,uint256)
                mstore(ptr, ERC20_TRANSFER_FROM)
                mstore(add(ptr, 0x04), orderSigner)
                mstore(add(ptr, 0x24), address())
                mstore(add(ptr, 0x44), cTokenTransferAmount)

                let success := call(gas(), cToken, 0, ptr, 0x64, ptr, 32)
                let rdsize := returndatasize()
                success := and(success, or(iszero(rdsize), and(gt(rdsize, 31), eq(mload(ptr), 1))))
                if iszero(success) {
                    returndatacopy(0, 0, rdsize)
                    revert(0, rdsize)
                }

                // redeem(uint256)
                mstore(0, 0xdb006a7500000000000000000000000000000000000000000000000000000000)
                mstore(0x4, cTokenTransferAmount)
                if iszero(call(gas(), cToken, 0x0, 0x0, 0x24, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                rdsize := returndatasize()
                if and(eq(rdsize, 1), xor(mload(0x0), 0)) {
                    returndatacopy(0, 0, rdsize)
                    revert(0, rdsize)
                }
            }
            case 1 {
                // redeemBehalf(address,uint256)
                mstore(ptr, 0x210bc05200000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x4), orderSigner)
                mstore(add(ptr, 0x24), cTokenTransferAmount)
                if iszero(call(gas(), cToken, 0x0, ptr, 0x44, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                let rdsize := returndatasize()
                if and(eq(rdsize, 1), xor(mload(0), 0)) {
                    returndatacopy(0, 0, rdsize)
                    revert(0, rdsize)
                }
            }
            case 2 {
                // redeem(address,uint256) - iToken style
                mstore(ptr, 0x1e9a695000000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x4), orderSigner)
                mstore(add(ptr, 0x24), cTokenTransferAmount)
                if iszero(call(gas(), cToken, 0x0, ptr, 0x44, 0x0, 0x0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }
            default { revert(0, 0) }

            if xor(address(), receiver) {
                switch asset
                case 0 {
                    if iszero(call(gas(), receiver, amount, 0, 0, 0, 0)) {
                        mstore(0, NATIVE_TRANSFER_FAILED)
                        revert(0, 0x4)
                    }
                }
                default {
                    mstore(ptr, ERC20_TRANSFER)
                    mstore(add(ptr, 0x04), receiver)
                    mstore(add(ptr, 0x24), amount)

                    let success := call(gas(), asset, 0, ptr, 0x44, ptr, 32)
                    let rdsize := returndatasize()
                    success := and(
                        success,
                        or(iszero(rdsize), and(gt(rdsize, 31), eq(mload(ptr), 1)))
                    )
                    if iszero(success) {
                        returndatacopy(0, 0, rdsize)
                        revert(0, rdsize)
                    }
                }
            }

            amountOut := amount
        }
    }

    /**
     * @notice Deposits to Compound V2 lending pool
     * @param asset The underlying token address (0 = native)
     * @param amount The amount to deposit (0 = contract balance)
     * @param receiver The address to receive cTokens
     * @param data Lender-specific data: [1: selectorId][20: cToken]
     */
    function _depositToCompoundV2(
        address asset,
        uint256 amount,
        address receiver,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let d := add(data, 0x20)
            let selectorId := shr(248, mload(d))
            let cToken := shr(96, mload(add(d, 1)))

            switch asset
            case 0 {
                if iszero(amount) { amount := selfbalance() }

                if amount {
                switch selectorId
                case 2 {
                    // mint(address)
                    mstore(0, 0x6a62784200000000000000000000000000000000000000000000000000000000)
                    mstore(0x04, receiver)
                    if iszero(call(gas(), cToken, amount, 0x0, 0x24, 0x0, 0x0)) {
                        returndatacopy(0x0, 0, returndatasize())
                        revert(0x0, returndatasize())
                    }
                }
                default {
                    // mint()
                    mstore(0, 0x1249c58b00000000000000000000000000000000000000000000000000000000)
                    if iszero(call(gas(), cToken, amount, 0x0, 0x4, 0x0, 0x20)) {
                        returndatacopy(0x0, 0, returndatasize())
                        revert(0x0, returndatasize())
                    }

                    if xor(receiver, address()) {
                        mstore(0, ERC20_BALANCE_OF)
                        mstore(0x04, address())
                        if iszero(staticcall(gas(), cToken, 0x0, 0x24, 0x0, 0x20)) {
                            returndatacopy(0, 0, returndatasize())
                            revert(0, returndatasize())
                        }
                        let cBalance := mload(0x0)

                        let ptr := mload(0x40)
                        mstore(ptr, ERC20_TRANSFER)
                        mstore(add(ptr, 0x04), receiver)
                        mstore(add(ptr, 0x24), cBalance)

                        let success := call(gas(), cToken, 0, ptr, 0x44, ptr, 32)
                        let rdsize := returndatasize()
                        if iszero(
                            and(
                                success,
                                or(iszero(rdsize), and(gt(rdsize, 31), eq(mload(ptr), 1)))
                            )
                        ) {
                            returndatacopy(0, 0, rdsize)
                            revert(0, rdsize)
                        }
                    }
                }
                } // if amount
            }
            default {
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

                switch selectorId
                case 0 {
                    // mintBehalf(address,uint256)
                    mstore(ptr, 0x23323e0300000000000000000000000000000000000000000000000000000000)
                    mstore(add(ptr, 0x04), receiver)
                    mstore(add(ptr, 0x24), amount)
                    if iszero(call(gas(), cToken, 0x0, ptr, 0x44, 0x0, 0x20)) {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    let rdsize := returndatasize()
                    if and(eq(rdsize, 1), xor(mload(0), 0)) {
                        returndatacopy(0, 0, rdsize)
                        revert(0, rdsize)
                    }
                }
                case 1 {
                    // mint(uint)
                    mstore(ptr, 0xa0712d6800000000000000000000000000000000000000000000000000000000)
                    mstore(add(ptr, 0x04), amount)
                    if iszero(call(gas(), cToken, 0x0, ptr, 0x24, 0x0, 0x20)) {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    let rdsize := returndatasize()
                    if and(eq(rdsize, 1), xor(mload(0), 0)) {
                        returndatacopy(0, 0, rdsize)
                        revert(0, rdsize)
                    }

                    if xor(receiver, address()) {
                        mstore(0, ERC20_BALANCE_OF)
                        mstore(0x04, address())
                        if iszero(staticcall(gas(), cToken, 0x0, 0x24, 0x0, 0x20)) {
                            returndatacopy(0, 0, returndatasize())
                            revert(0, returndatasize())
                        }
                        let cBalance := mload(0x0)

                        mstore(ptr, ERC20_TRANSFER)
                        mstore(add(ptr, 0x04), receiver)
                        mstore(add(ptr, 0x24), cBalance)

                        let success := call(gas(), cToken, 0, ptr, 0x44, ptr, 32)
                        rdsize := returndatasize()
                        if iszero(
                            and(
                                success,
                                or(iszero(rdsize), and(gt(rdsize, 31), eq(mload(ptr), 1)))
                            )
                        ) {
                            returndatacopy(0, 0, rdsize)
                            revert(0, rdsize)
                        }
                    }
                }
                case 2 {
                    // mint(address,uint256) - iToken style
                    mstore(ptr, 0x40c10f1900000000000000000000000000000000000000000000000000000000)
                    mstore(add(ptr, 0x04), receiver)
                    mstore(add(ptr, 0x24), amount)
                    if iszero(call(gas(), cToken, 0x0, ptr, 0x44, 0x0, 0x0)) {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                }
                default { revert(0, 0) }
                } // if amount
            }

            amountIn := amount
        }
    }

    /**
     * @notice Repays debt to Compound V2 lending pool
     * @param asset The underlying token address (0 = native)
     * @param amount The amount to repay (0 = contract balance, type(uint112).max = safe max)
     * @param receiver The borrower address (on behalf of)
     * @param data Lender-specific data: [20: cToken]
     */
    function _repayToCompoundV2(
        address asset,
        uint256 amount,
        address receiver,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let cToken := shr(96, mload(add(data, 0x20)))
            let ptr := mload(0x40)

            switch asset
            case 0 {
                switch amount
                case 0 { amount := selfbalance() }
                case 0xffffffffffffffffffffffffffff {
                    amount := selfbalance()
                    // borrowBalanceCurrent(address)
                    mstore(0, 0x17bfdfbc00000000000000000000000000000000000000000000000000000000)
                    mstore(0x04, receiver)
                    pop(call(gas(), cToken, 0x0, 0x0, 0x24, 0x0, 0x20))
                    let borrowBa := mload(0x0)
                    if lt(borrowBa, amount) { amount := borrowBa }
                }

                // repayBorrowBehalf(address)
                mstore(0, 0xe597461900000000000000000000000000000000000000000000000000000000)
                mstore(4, receiver)
                if iszero(call(gas(), cToken, amount, 0, 0x24, 0, 0x0)) {
                    returndatacopy(0x0, 0, returndatasize())
                    revert(0x0, returndatasize())
                }
            }
            default {
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

                    // borrowBalanceCurrent(address)
                    mstore(0, 0x17bfdfbc00000000000000000000000000000000000000000000000000000000)
                    mstore(0x04, receiver)
                    pop(call(gas(), cToken, 0x0, 0x0, 0x24, 0x0, 0x20))
                    if lt(mload(0x0), amount) { amount := MAX_UINT256 }
                }

                // repayBorrowBehalf(address,uint256)
                mstore(ptr, 0x2608f81800000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x4), receiver)
                mstore(add(ptr, 0x24), amount)
                if iszero(call(gas(), cToken, 0x0, ptr, 0x44, ptr, 0x20)) {
                    returndatacopy(0x0, 0, returndatasize())
                    revert(0x0, returndatasize())
                }
                let rdsize := returndatasize()
                if and(eq(rdsize, 1), xor(mload(ptr), 0)) {
                    returndatacopy(0, 0, rdsize)
                    revert(0, rdsize)
                }
            }

            amountIn := amount
        }
    }
}
