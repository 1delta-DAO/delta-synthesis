// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {ERC20Selectors} from "../../selectors/ERC20Selectors.sol";
import {Masks} from "../../masks/Masks.sol";

/**
 * @title MorphoSettlementLending
 * @notice Settlement lending module for Morpho Blue isolated lending markets.
 * @dev Provides low-level assembly interactions for all Morpho Blue operations including
 *      supply, borrow, repay, and collateral management. Morpho Blue uses market-specific
 *      params (loanToken, collateralToken, oracle, irm, lltv) to identify each isolated market.
 *
 *      Supported operations:
 *        - Borrow:               Calls morpho.borrow() on behalf of caller
 *        - Deposit (lending):    Calls morpho.supply() to supply loan tokens with optional callback
 *        - Deposit (collateral): Calls morpho.supplyCollateral() with optional callback.
 *                                Supports Lista native staking via LISTA_PROVIDER_SUPPLY_COLLATERAL
 *        - Withdraw (collateral):Calls morpho.withdrawCollateral() on behalf of caller
 *        - Withdraw (lending):   Calls morpho.withdraw() to redeem supply shares
 *        - Repay:                Calls morpho.repay() with safe-max logic that accrues interest,
 *                                reads market totals, and caps repayment to exact debt
 *
 *      Amount semantics:
 *        - 0:                       Use contract's current balance (or selfbalance() for native)
 *        - type(uint112).max:       Use full position balance (reads position() for shares/collateral)
 *        - any other value:         Use as-is (interpreted as assets or shares based on USE_SHARES_FLAG)
 *
 *      Flags byte at blob offset 96:
 *        - Bit 127 (NATIVE_FLAG):     Asset is native (uses Lista provider for collateral, selfbalance() for amounts)
 *        - Bit 126 (USE_SHARES_FLAG): Amount parameter represents shares instead of assets
 *
 *      Data layout: [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho][2: calldataLen][calldataLen: calldata]
 */
abstract contract MorphoSettlementLending is ERC20Selectors, Masks {
    error ListaProviderCallbackNotAllowed();

    /// @dev  position(...)
    bytes32 private constant MORPHO_POSITION = 0x93c5206200000000000000000000000000000000000000000000000000000000;

    /// @dev  market(...)
    bytes32 private constant MORPHO_MARKET = 0x5c60e39a00000000000000000000000000000000000000000000000000000000;

    /// @dev  repay(...)
    bytes32 private constant MORPHO_REPAY = 0x20b76e8100000000000000000000000000000000000000000000000000000000;

    /// @dev  supplyCollateral(...)
    bytes32 private constant MORPHO_SUPPLY_COLLATERAL = 0x238d657900000000000000000000000000000000000000000000000000000000;

    /// @dev  supply(...)
    bytes32 private constant MORPHO_SUPPLY = 0xa99aad8900000000000000000000000000000000000000000000000000000000;

    /// @dev  borrow(...)
    bytes32 private constant MORPHO_BORROW = 0x50d8cd4b00000000000000000000000000000000000000000000000000000000;

    /// @dev  withdrawCollateral(...)
    bytes32 private constant MORPHO_WITHDRAW_COLLATERAL = 0x8720316d00000000000000000000000000000000000000000000000000000000;

    bytes32 private constant LISTA_PROVIDER_SUPPLY_COLLATERAL =
        0xac69d35900000000000000000000000000000000000000000000000000000000;

    /**
     * @notice Borrows from Morpho Blue lending pool
     * @param amount The amount to borrow
     * @param receiver The address to receive borrowed tokens
     * @param orderSigner Address of the caller (onBehalfOf)
     * @param data Lender-specific data:
     *   [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho]
     */
    function _morphoBorrow(
        address, /* asset */
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptr := mload(0x40)
            let d := add(data, 0x20)

            mstore(ptr, MORPHO_BORROW)

            mstore(add(ptr, 4), shr(96, mload(d)))               // loanToken
            mstore(add(ptr, 36), shr(96, mload(add(d, 20))))     // collateralToken
            mstore(add(ptr, 68), shr(96, mload(add(d, 40))))     // oracle
            mstore(add(ptr, 100), shr(96, mload(add(d, 60))))    // irm

            let lltvAndFlags := mload(add(d, 80))
            mstore(add(ptr, 132), shr(128, lltvAndFlags))         // lltv

            switch and(USE_SHARES_FLAG, lltvAndFlags)
            case 0 {
                mstore(add(ptr, 164), amount) // assets
                mstore(add(ptr, 196), 0)      // shares
            }
            default {
                mstore(add(ptr, 164), 0)      // assets
                mstore(add(ptr, 196), amount) // shares
            }

            mstore(add(ptr, 228), orderSigner) // onBehalfOf
            mstore(add(ptr, 260), receiver)      // receiver

            let morpho := shr(96, mload(add(d, 97)))

            if iszero(call(gas(), morpho, 0x0, ptr, 292, 0x0, 0x0)) {
                let rdlen := returndatasize()
                returndatacopy(0, 0, rdlen)
                revert(0x0, rdlen)
            }

            amountOut := amount
        }
    }

    /**
     * @notice Deposits lending token to Morpho Blue
     * @param asset The loan token address (used for balance lookup when amount=0)
     * @param amount The amount to deposit (0 = contract balance)
     * @param receiver The address to receive supply position
     * @param orderSigner Address of the caller (for callbacks)
     * @param data Lender-specific data:
     *   [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho][2: calldataLen][calldataLen: calldata]
     */
    function _encodeMorphoDeposit(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptrBase := mload(0x40)
            let ptr := add(128, ptrBase)
            let d := add(data, 0x20)

            mstore(ptr, MORPHO_SUPPLY)

            mstore(add(ptr, 4), shr(96, mload(d)))
            mstore(add(ptr, 36), shr(96, mload(add(d, 20))))
            mstore(add(ptr, 68), shr(96, mload(add(d, 40))))
            mstore(add(ptr, 100), shr(96, mload(add(d, 60))))

            let lltvAndFlags := mload(add(d, 80))
            mstore(add(ptr, 132), shr(128, lltvAndFlags))

            switch and(USE_SHARES_FLAG, lltvAndFlags)
            case 0 {
                if iszero(amount) {
                    mstore(0, ERC20_BALANCE_OF)
                    mstore(0x04, address())
                    if iszero(staticcall(gas(), asset, 0x0, 0x24, 0x0, 0x20)) {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    amount := mload(0x0)
                }
                mstore(add(ptr, 164), amount)
                mstore(add(ptr, 196), 0)
            }
            default {
                mstore(add(ptr, 164), 0)
                mstore(add(ptr, 196), amount)
            }

            if amount {
            let morpho := shr(96, mload(add(d, 97)))

            let inputCalldataLength := and(UINT16_MASK, shr(240, mload(add(d, 117))))
            let calldataLength := inputCalldataLength

            mstore(add(ptr, 228), receiver)   // onBehalfOf
            mstore(add(ptr, 260), 0x120)      // offset

            if xor(0, calldataLength) {
                calldataLength := add(calldataLength, 20)
                mstore(add(ptr, 324), shl(96, orderSigner))
                // memory-to-memory copy of callback data
                let src := add(d, 119)
                let dest := add(ptr, 344)
                for { let i := 0 } lt(i, inputCalldataLength) { i := add(i, 32) } {
                    mstore(add(dest, i), mload(add(src, i)))
                }
            }

            mstore(add(ptr, 292), calldataLength)

            if iszero(call(gas(), morpho, 0x0, ptr, add(calldataLength, 324), 0x0, 0x0)) {
                let rdlen := returndatasize()
                returndatacopy(0, 0, rdlen)
                revert(0x0, rdlen)
            }

            amountIn := amount
            } // if amount
        }
    }

    /**
     * @notice Deposits collateral to Morpho Blue
     * @param asset The collateral token address (used for balance lookup when amount=0)
     * @param amount The amount to deposit (0 = contract balance)
     * @param receiver The address to receive collateral position
     * @param orderSigner Address of the caller (for callbacks)
     * @param data Lender-specific data:
     *   [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho][2: calldataLen][calldataLen: calldata]
     */
    function _encodeMorphoDepositCollateral(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptrBase := mload(0x40)
            let ptr := add(256, ptrBase)
            let d := add(data, 0x20)

            let lltvAndFlags := mload(add(d, 80))
            let target := shr(96, mload(add(d, 97)))
            let inputCalldataLength := and(UINT16_MASK, shr(240, mload(add(d, 117))))
            let calldataLength := inputCalldataLength

            let isNative := and(NATIVE_FLAG, lltvAndFlags)

            switch isNative
            case 0 {
                if iszero(amount) {
                    mstore(0, ERC20_BALANCE_OF)
                    mstore(0x04, address())
                    if iszero(staticcall(gas(), asset, 0x0, 0x24, 0x0, 0x20)) {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    amount := mload(0x0)
                }
                mstore(ptr, MORPHO_SUPPLY_COLLATERAL)
            }
            default {
                if iszero(amount) { amount := selfbalance() }
                mstore(ptr, LISTA_PROVIDER_SUPPLY_COLLATERAL)
            }

            if amount {
            mstore(add(ptr, 4), shr(96, mload(d)))
            mstore(add(ptr, 36), shr(96, mload(add(d, 20))))
            mstore(add(ptr, 68), shr(96, mload(add(d, 40))))
            mstore(add(ptr, 100), shr(96, mload(add(d, 60))))
            mstore(add(ptr, 132), shr(128, lltvAndFlags))

            switch isNative
            case 0 {
                mstore(add(ptr, 164), amount)
                mstore(add(ptr, 196), receiver)
                mstore(add(ptr, 228), 0x100)
                if xor(0, calldataLength) {
                    calldataLength := add(calldataLength, 20)
                    mstore(add(ptr, 292), shl(96, orderSigner))
                    let src := add(d, 119)
                    let dest := add(ptr, 312)
                    for { let i := 0 } lt(i, inputCalldataLength) { i := add(i, 32) } {
                        mstore(add(dest, i), mload(add(src, i)))
                    }
                }
                mstore(add(ptr, 260), calldataLength)
                if iszero(call(gas(), target, 0x0, ptr, add(calldataLength, 292), 0x0, 0x0)) {
                    let rdlen := returndatasize()
                    returndatacopy(0, 0, rdlen)
                    revert(0x0, rdlen)
                }
            }
            default {
                mstore(add(ptr, 164), receiver)
                mstore(add(ptr, 196), 0xE0)
                switch calldataLength
                case 0 {
                    mstore(add(ptr, 228), 0)
                    if iszero(call(gas(), target, amount, ptr, 260, 0x0, 0x0)) {
                        let rdlen := returndatasize()
                        returndatacopy(0, 0, rdlen)
                        revert(0x0, rdlen)
                    }
                }
                default {
                    // ListaProviderCallbackNotAllowed()
                    mstore(0x0, 0x88036ba500000000000000000000000000000000000000000000000000000000)
                    revert(0x0, 0x04)
                }
            }

            amountIn := amount
            } // if amount
        }
    }

    /**
     * @notice Withdraws collateral from Morpho Blue
     * @param amount The amount to withdraw (type(uint112).max = user's full collateral balance)
     * @param receiver The address to receive withdrawn collateral
     * @param orderSigner Address of the caller (onBehalfOf)
     * @param data Lender-specific data:
     *   [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho]
     */
    function _encodeMorphoWithdrawCollateral(
        address, /* asset */
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptr := mload(0x40)
            let d := add(data, 0x20)

            mstore(ptr, MORPHO_WITHDRAW_COLLATERAL)

            mstore(add(ptr, 4), shr(96, mload(d)))
            mstore(add(ptr, 36), shr(96, mload(add(d, 20))))
            mstore(add(ptr, 68), shr(96, mload(add(d, 40))))
            mstore(add(ptr, 100), shr(96, mload(add(d, 60))))

            let lltvAndFlags := mload(add(d, 80))
            mstore(add(ptr, 132), shr(128, lltvAndFlags))

            mstore(add(ptr, 196), orderSigner) // onBehalfOf
            mstore(add(ptr, 228), receiver)      // receiver

            let morpho := shr(96, mload(add(d, 97)))
            let isNative := and(NATIVE_FLAG, lltvAndFlags)

            let morphoRead := morpho
            if isNative {
                mstore(0x0, 0x195be17a00000000000000000000000000000000000000000000000000000000) // MOOLAH()
                if iszero(staticcall(gas(), morpho, 0x0, 0x04, 0x0, 0x20)) { revert(0x0, 0x0) }
                morphoRead := mload(0x0)
            }

            if eq(amount, 0xffffffffffffffffffffffffffff) {
                let ptrBase := add(ptr, 280)
                let marketId := keccak256(add(ptr, 4), 160)
                mstore(ptrBase, MORPHO_POSITION)
                mstore(add(ptrBase, 0x4), marketId)
                mstore(add(ptrBase, 0x24), orderSigner)
                if iszero(staticcall(gas(), morphoRead, ptrBase, 0x44, ptrBase, 0x60)) { revert(0x0, 0x0) }
                amount := mload(add(ptrBase, 0x40))
            }

            mstore(add(ptr, 164), amount)

            if iszero(call(gas(), morpho, 0x0, ptr, 260, 0x0, 0x0)) {
                let rdlen := returndatasize()
                returndatacopy(0, 0, rdlen)
                revert(0x0, rdlen)
            }

            amountOut := amount
        }
    }

    /**
     * @notice Withdraws borrow asset from Morpho Blue
     * @param amount The amount to withdraw (type(uint112).max = user's full supply balance)
     * @param receiver The address to receive withdrawn tokens
     * @param orderSigner Address of the caller (onBehalfOf)
     * @param data Lender-specific data:
     *   [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho]
     */
    function _encodeMorphoWithdraw(
        address, /* asset */
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptrBase := mload(0x40)
            let ptr := add(ptrBase, 256)
            let d := add(data, 0x20)

            mstore(add(ptr, 4), shr(96, mload(d)))
            mstore(add(ptr, 36), shr(96, mload(add(d, 20))))
            mstore(add(ptr, 68), shr(96, mload(add(d, 40))))
            mstore(add(ptr, 100), shr(96, mload(add(d, 60))))

            let lltvAndFlags := mload(add(d, 80))
            mstore(add(ptr, 132), shr(128, lltvAndFlags))

            mstore(add(ptr, 228), orderSigner) // onBehalfOf
            mstore(add(ptr, 260), receiver)      // receiver

            let morpho := shr(96, mload(add(d, 97)))

            switch and(USE_SHARES_FLAG, lltvAndFlags)
            case 0 {
                switch amount
                case 0xffffffffffffffffffffffffffff {
                    let marketId := keccak256(add(ptr, 4), 160)
                    mstore(ptrBase, MORPHO_POSITION)
                    mstore(add(ptrBase, 0x4), marketId)
                    mstore(add(ptrBase, 0x24), orderSigner)
                    if iszero(staticcall(gas(), morpho, ptrBase, 0x44, ptrBase, 0x20)) { revert(0x0, 0x0) }
                    mstore(add(ptr, 164), 0)             // assets
                    mstore(add(ptr, 196), mload(ptrBase)) // shares
                }
                default {
                    mstore(add(ptr, 164), amount) // assets
                    mstore(add(ptr, 196), 0)      // shares
                }
            }
            default {
                mstore(add(ptr, 164), 0)      // assets
                mstore(add(ptr, 196), amount) // shares
            }

            // withdraw(...)
            mstore(sub(ptr, 28), 0x5c2bea49)
            if iszero(call(gas(), morpho, 0x0, ptr, 292, 0x0, 0x0)) {
                let rdlen := returndatasize()
                returndatacopy(0, 0, rdlen)
                revert(0x0, rdlen)
            }

            amountOut := amount
        }
    }

    /**
     * @notice Repays debt to Morpho Blue
     * @param asset The loan token address (used for balance lookup)
     * @param amount The amount to repay (0 = contract balance, type(uint112).max = safe max)
     * @param receiver The borrower address (on behalf of)
     * @param orderSigner Address of the caller (for callbacks)
     * @param data Lender-specific data:
     *   [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho][2: calldataLen][calldataLen: calldata]
     */
    function _morphoRepay(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptrBase := mload(0x40)
            let ptr := add(ptrBase, 256)
            let d := add(data, 0x20)

            mstore(add(ptr, 4), shr(96, mload(d)))
            mstore(add(ptr, 36), shr(96, mload(add(d, 20))))
            mstore(add(ptr, 68), shr(96, mload(add(d, 40))))
            mstore(add(ptr, 100), shr(96, mload(add(d, 60))))

            let lltvAndFlags := mload(add(d, 80))
            mstore(add(ptr, 132), shr(128, lltvAndFlags))

            let isNative := and(NATIVE_FLAG, lltvAndFlags)
            let isShares := and(USE_SHARES_FLAG, lltvAndFlags)

            let morpho := shr(96, mload(add(d, 97)))
            let repayAm := amount

            switch repayAm
            case 0xffffffffffffffffffffffffffff {
                switch isNative
                case 0 {
                    mstore(0x0, ERC20_BALANCE_OF)
                    mstore(0x04, address())
                    if iszero(staticcall(gas(), asset, 0x0, 0x24, 0x0, 0x20)) { revert(0x0, 0x0) }
                    repayAm := mload(0x0)
                }
                default { repayAm := selfbalance() }

                let morphoRead := morpho
                if isNative {
                    mstore(0x0, 0x195be17a00000000000000000000000000000000000000000000000000000000)
                    if iszero(staticcall(gas(), morpho, 0x0, 0x04, 0x0, 0x20)) { revert(0x0, 0x0) }
                    morphoRead := mload(0x0)
                }

                // accrue interest (0x151c1ade)
                mstore(sub(ptr, 28), 0x151c1ade)
                if iszero(call(gas(), morphoRead, 0x0, ptr, 0xA4, 0x0, 0x0)) { revert(0x0, 0x0) }

                let marketId := keccak256(add(ptr, 4), 160)
                mstore(0x0, MORPHO_MARKET)
                mstore(0x4, marketId)
                if iszero(staticcall(gas(), morphoRead, 0x0, 0x24, ptrBase, 0x80)) { revert(0x0, 0x0) }
                let totalBorrowAssets := mload(add(ptrBase, 0x40))
                let totalBorrowShares := mload(add(ptrBase, 0x60))

                mstore(ptrBase, MORPHO_POSITION)
                mstore(add(ptrBase, 0x4), marketId)
                mstore(add(ptrBase, 0x24), receiver)
                if iszero(staticcall(gas(), morphoRead, ptrBase, 0x44, ptrBase, 0x40)) { revert(0x0, 0x0) }
                let userBorrowShares := mload(add(ptrBase, 0x20))

                // mulDivUp
                let maxAssets := add(totalBorrowShares, 1000000)
                maxAssets := div(
                    add(
                        mul(userBorrowShares, add(totalBorrowAssets, 1)),
                        sub(maxAssets, 1)
                    ),
                    maxAssets
                )

                switch gt(maxAssets, repayAm)
                case 1 {
                    mstore(add(ptr, 164), repayAm)
                    mstore(add(ptr, 196), 0)
                }
                default {
                    mstore(add(ptr, 164), 0)
                    mstore(add(ptr, 196), userBorrowShares)
                    repayAm := maxAssets
                }
            }
            case 0 {
                switch isNative
                case 0 {
                    mstore(0x0, ERC20_BALANCE_OF)
                    mstore(0x04, address())
                    if iszero(staticcall(gas(), asset, 0x0, 0x24, 0x0, 0x20)) { revert(0x0, 0x0) }
                    repayAm := mload(0x0)
                }
                default { repayAm := selfbalance() }

                mstore(add(ptr, 164), repayAm)
                mstore(add(ptr, 196), 0)
            }
            default {
                switch isShares
                case 0 {
                    mstore(add(ptr, 164), repayAm)
                    mstore(add(ptr, 196), 0)
                }
                default {
                    mstore(add(ptr, 164), 0)
                    mstore(add(ptr, 196), repayAm)
                }
            }

            let callValue := mul(repayAm, iszero(iszero(isNative)))

            mstore(add(ptr, 228), receiver) // onBehalfOf
            mstore(add(ptr, 260), 0x120)    // offset

            let inputCalldataLength := and(UINT16_MASK, shr(240, mload(add(d, 117))))
            let calldataLength := inputCalldataLength

            if isNative {
                if calldataLength {
                    // ListaProviderCallbackNotAllowed()
                    mstore(0x0, 0x88036ba500000000000000000000000000000000000000000000000000000000)
                    revert(0x0, 0x04)
                }
            }

            if xor(0, calldataLength) {
                calldataLength := add(calldataLength, 20)
                mstore(add(ptr, 324), shl(96, orderSigner))
                // memory-to-memory copy of callback data
                let src := add(d, 119)
                let dest := add(ptr, 344)
                for { let i := 0 } lt(i, inputCalldataLength) { i := add(i, 32) } {
                    mstore(add(dest, i), mload(add(src, i)))
                }
            }

            // repay(...)
            mstore(sub(ptr, 28), 0x20b76e81)
            mstore(add(ptr, 292), calldataLength)
            if iszero(call(gas(), morpho, callValue, ptr, add(calldataLength, 324), 0x0, 0x0)) {
                let rdlen := returndatasize()
                returndatacopy(0, 0, rdlen)
                revert(0x0, rdlen)
            }

            amountIn := repayAm
        }
    }
}
