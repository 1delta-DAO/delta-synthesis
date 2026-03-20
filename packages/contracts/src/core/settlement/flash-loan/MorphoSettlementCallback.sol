// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {SettlementExecutor} from "../SettlementExecutor.sol";

/**
 * @title MorphoSettlementCallback (Base)
 * @notice Abstract base for Morpho-style settlement callbacks.
 *         Subcontracts parse the callback calldata and call _executeSettlement.
 *
 * @dev Callback calldata layout (starting at offset 100, after ABI prefix):
 *   [20: orderSigner][1: poolId][8: maxFeeBps]
 *   [2: orderDataLen][orderDataLen: orderData]
 *   [2: fillerCalldataLen][fillerCalldataLen: fillerCalldata]
 *   [remaining: executionData]
 */
abstract contract MorphoSettlementCallback is SettlementExecutor {
    function onMorphoFlashLoan(uint256, bytes calldata) external {
        _onMorphoSettlementCallback();
    }

    /**
     * @notice Returns the trusted Morpho pool address for caller validation.
     * @dev Override per-chain to return the chain-specific address.
     */
    function _morphoPool() internal pure virtual returns (address);

    function _onMorphoSettlementCallback() internal {
        address orderSigner;
        uint256 maxFeeBps;
        bytes memory orderData;
        bytes memory fillerCalldata;
        bytes memory executionData;

        address pool = _morphoPool();
        assembly {
            let firstWord := calldataload(100)

            switch and(0xff, shr(88, firstWord))
            case 0 {
                if xor(caller(), pool) {
                    mstore(0, INVALID_CALLER)
                    revert(0, 0x4)
                }
            }
            default {
                mstore(0, INVALID_FLASH_LOAN)
                revert(0, 0x4)
            }

            orderSigner := shr(96, firstWord)
            maxFeeBps := shr(192, calldataload(121))

            let baseOffset := 129
            let orderLen := and(0xffff, shr(240, calldataload(baseOffset)))

            let fmp := mload(0x40)
            orderData := fmp
            mstore(fmp, orderLen)
            calldatacopy(add(fmp, 0x20), add(baseOffset, 2), orderLen)
            fmp := add(add(fmp, 0x20), and(add(orderLen, 31), not(31)))

            let fillerStart := add(add(baseOffset, 2), orderLen)
            let fillerLen := and(0xffff, shr(240, calldataload(fillerStart)))

            fillerCalldata := fmp
            mstore(fmp, fillerLen)
            calldatacopy(add(fmp, 0x20), add(fillerStart, 2), fillerLen)
            fmp := add(add(fmp, 0x20), and(add(fillerLen, 31), not(31)))

            let execStart := add(add(fillerStart, 2), fillerLen)
            let totalParamsLen := calldataload(68)
            let execLen := sub(totalParamsLen, sub(execStart, 100))

            executionData := fmp
            mstore(fmp, execLen)
            calldatacopy(add(fmp, 0x20), execStart, execLen)
            mstore(0x40, add(add(fmp, 0x20), and(add(execLen, 31), not(31))))
        }

        _executeSettlement(orderSigner, maxFeeBps, orderData, executionData, fillerCalldata);
    }
}
