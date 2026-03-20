// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {ERC20Selectors} from "../../selectors/ERC20Selectors.sol";
import {Masks} from "../../masks/Masks.sol";

// solhint-disable max-line-length

/**
 * @title AaveSettlementLending
 * @notice Settlement lending module for Aave V2 and V3 protocols.
 * @dev Provides low-level assembly interactions for deposit, withdraw, borrow, and repay
 *      operations on Aave lending pools. All lender-specific parameters (pool address, aToken,
 *      debtToken, interest rate mode) are encoded in a tightly-packed `bytes memory` blob.
 *
 *      Supported operations:
 *        - Withdraw:    Pulls aTokens from caller via transferFrom, calls pool.withdraw()
 *        - Borrow:      Calls pool.borrow() on behalf of caller, optionally forwards tokens to receiver
 *        - Deposit V3:  Calls pool.supply() (Aave V3 interface)
 *        - Deposit V2:  Calls pool.deposit() (Aave V2 interface)
 *        - Repay:       Calls pool.repay() with mode-dependent selector (V2 vs V3)
 *
 *      Amount semantics:
 *        - 0:                       Use contract's current balance of the asset
 *        - type(uint112).max:       Use caller's full aToken/debtToken balance (max withdraw/repay)
 *        - any other value:         Use as-is
 *
 *      Data layout per function is documented in the respective function NatSpec.
 */
abstract contract AaveSettlementLending is ERC20Selectors, Masks {
    /**
     * @notice Withdraws from Aave lending pool
     * @param asset The underlying token address
     * @param amount The amount to withdraw (type(uint112).max = user's full aToken balance)
     * @param receiver The address to receive withdrawn tokens
     * @param orderSigner Address of the caller
     * @param data Lender-specific data: [20: aToken][20: pool]
     * @return amountIn Always 0 for withdrawals
     * @return amountOut The actual amount withdrawn (resolved from max if applicable)
     */
    function _withdrawFromAave(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let ptr := mload(0x40)
            let d := add(data, 0x20)

            let collateralToken := shr(96, mload(d))
            let pool := shr(96, mload(add(d, 20)))

            // apply max if needed
            switch amount
            case 0xffffffffffffffffffffffffffff {
                // selector for balanceOf(address)
                mstore(0, ERC20_BALANCE_OF)
                mstore(0x04, orderSigner)
                if iszero(staticcall(gas(), collateralToken, 0x0, 0x24, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                amount := mload(0x0)
            }

            // TRANSFER_FROM USER
            mstore(ptr, ERC20_TRANSFER_FROM)
            mstore(add(ptr, 0x04), orderSigner)
            mstore(add(ptr, 0x24), address())
            mstore(add(ptr, 0x44), amount)

            let success := call(gas(), collateralToken, 0x0, ptr, 0x64, 0x0, 0x20)
            let rdsize := returndatasize()
            success := and(
                success,
                or(
                    iszero(rdsize),
                    and(gt(rdsize, 31), eq(mload(0x0), 1))
                )
            )
            if iszero(success) {
                returndatacopy(0x0, 0x0, rdsize)
                revert(0x0, rdsize)
            }

            // selector withdraw(address,uint256,address)
            mstore(ptr, 0x69328dec00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), asset)
            mstore(add(ptr, 0x24), amount)
            mstore(add(ptr, 0x44), receiver)

            if iszero(call(gas(), pool, 0x0, ptr, 0x64, 0x0, 0x0)) {
                returndatacopy(0x0, 0x0, returndatasize())
                revert(0x0, returndatasize())
            }

            amountOut := amount
        }
    }

    /**
     * @notice Borrows from Aave lending pool
     * @param asset The underlying token address to borrow
     * @param amount The amount to borrow
     * @param receiver The address to receive borrowed tokens
     * @param orderSigner Address of the caller
     * @param data Lender-specific data: [1: mode][20: pool]
     * @return amountIn Always 0 for borrows
     * @return amountOut The amount borrowed
     */
    function _borrowFromAave(
        address asset,
        uint256 amount,
        address receiver,
        address orderSigner,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let d := add(data, 0x20)
            let mode := shr(248, mload(d))
            let pool := shr(96, mload(add(d, 1)))

            let ptr := mload(0x40)
            switch mode
            case 0 {
                // borrow(address,uint256,uint16,address)
                mstore(ptr, 0x1d5d723700000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), asset)
                mstore(add(ptr, 0x24), amount)
                mstore(add(ptr, 0x44), 0x0)
                mstore(add(ptr, 0x64), orderSigner)
                if iszero(call(gas(), pool, 0x0, ptr, 0x84, 0x0, 0x0)) {
                    returndatacopy(0x0, 0x0, returndatasize())
                    revert(0x0, returndatasize())
                }
            }
            default {
                // borrow(address,uint256,uint256,uint16,address)
                mstore(ptr, 0xa415bcad00000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), asset)
                mstore(add(ptr, 0x24), amount)
                mstore(add(ptr, 0x44), mode)
                mstore(add(ptr, 0x64), 0x0)
                mstore(add(ptr, 0x84), orderSigner)
                if iszero(call(gas(), pool, 0x0, ptr, 0xA4, 0x0, 0x0)) {
                    returndatacopy(0x0, 0x0, returndatasize())
                    revert(0x0, returndatasize())
                }
            }

            // transfer underlying if needed
            if xor(receiver, address()) {
                mstore(ptr, ERC20_TRANSFER)
                mstore(add(ptr, 0x04), receiver)
                mstore(add(ptr, 0x24), amount)

                let success := call(gas(), asset, 0, ptr, 0x44, ptr, 32)
                let rdsize := returndatasize()
                success := and(
                    success,
                    or(
                        iszero(rdsize),
                        and(gt(rdsize, 31), eq(mload(ptr), 1))
                    )
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
     * @notice Deposits to Aave V3 lending pool
     * @param asset The underlying token address to deposit
     * @param amount The amount to deposit (0 = contract balance)
     * @param receiver The address to receive aTokens
     * @param data Lender-specific data: [20: pool]
     * @return amountIn The actual amount deposited (resolved from 0 if applicable)
     * @return amountOut Always 0 for deposits
     */
    function _depositToAaveV3(
        address asset,
        uint256 amount,
        address receiver,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let pool := shr(96, mload(add(data, 0x20)))

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
                // supply(address,uint256,address,uint16)
                mstore(ptr, 0x617ba03700000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), asset)
                mstore(add(ptr, 0x24), amount)
                mstore(add(ptr, 0x44), receiver)
                mstore(add(ptr, 0x64), 0x0)
                if iszero(call(gas(), pool, 0x0, ptr, 0x84, 0x0, 0x0)) {
                    returndatacopy(0x0, 0x0, returndatasize())
                    revert(0x0, returndatasize())
                }

                amountIn := amount
            }
        }
    }

    /**
     * @notice Deposits to Aave V2 lending pool
     * @param asset The underlying token address to deposit
     * @param amount The amount to deposit (0 = contract balance)
     * @param receiver The address to receive aTokens
     * @param data Lender-specific data: [20: pool]
     * @return amountIn The actual amount deposited (resolved from 0 if applicable)
     * @return amountOut Always 0 for deposits
     */
    function _depositToAaveV2(
        address asset,
        uint256 amount,
        address receiver,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let pool := shr(96, mload(add(data, 0x20)))

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
                // deposit(address,uint256,address,uint16)
                mstore(ptr, 0xe8eda9df00000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), asset)
                mstore(add(ptr, 0x24), amount)
                mstore(add(ptr, 0x44), receiver)
                mstore(add(ptr, 0x64), 0x0)
                if iszero(call(gas(), pool, 0x0, ptr, 0x84, 0x0, 0x0)) {
                    returndatacopy(0x0, 0x0, returndatasize())
                    revert(0x0, returndatasize())
                }

                amountIn := amount
            }
        }
    }

    /**
     * @notice Repays debt to Aave lending pool
     * @param asset The underlying token address to repay
     * @param amount The amount to repay (0 = contract balance, type(uint112).max = safe max)
     * @param receiver The borrower address (on behalf of)
     * @param data Lender-specific data: [1: mode][20: debtToken][20: pool]
     * @return amountIn The actual amount repaid (resolved from max/0 if applicable)
     * @return amountOut Always 0 for repayments
     */
    function _repayToAave(
        address asset,
        uint256 amount,
        address receiver,
        bytes memory data
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        assembly {
            let d := add(data, 0x20)
            let mode := shr(248, mload(d))
            let debtToken := shr(96, mload(add(d, 1)))
            let pool := shr(96, mload(add(d, 21)))

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
                if iszero(staticcall(gas(), asset, 0x0, 0x24, 0x4, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                amount := mload(0x4)

                mstore(0x04, receiver)
                if iszero(staticcall(gas(), debtToken, 0x0, 0x24, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                let borrowBalance := mload(0x0)
                if lt(borrowBalance, amount) { amount := borrowBalance }
            }

            let ptr := mload(0x40)

            switch mode
            case 0 {
                // repay(address,uint256,address)
                mstore(ptr, 0x5ceae9c400000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), asset)
                mstore(add(ptr, 0x24), amount)
                mstore(add(ptr, 0x44), receiver)
                if iszero(call(gas(), pool, 0x0, ptr, 0x64, 0x0, 0x0)) {
                    returndatacopy(0x0, 0x0, returndatasize())
                    revert(0x0, returndatasize())
                }
            }
            default {
                // repay(address,uint256,uint256,address)
                mstore(ptr, 0x573ade8100000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), asset)
                mstore(add(ptr, 0x24), amount)
                mstore(add(ptr, 0x44), mode)
                mstore(add(ptr, 0x64), receiver)
                if iszero(call(gas(), pool, 0x0, ptr, 0x84, 0x0, 0x0)) {
                    returndatacopy(0x0, 0x0, returndatasize())
                    revert(0x0, returndatasize())
                }
            }

            amountIn := amount
        }
    }
}
