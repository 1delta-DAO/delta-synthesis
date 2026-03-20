// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {Masks} from "../../masks/Masks.sol";

/**
 * @title Morpho flash loans (settlement version)
 */
contract MorphoFlashLoans is Masks {
    /**
     * @notice Executes Morpho flash loan
     * @dev We allow ANY morpho style pool here
     * @param asset The token to flash-borrow
     * @param amount The amount to flash-borrow
     * @param orderSigner Address of the caller
     * @param data Lender-specific data:
     *   [20: pool][2: paramsLength][paramsLength: params]
     */
    function morphoFlashLoan(
        address asset,
        uint256 amount,
        address orderSigner,
        bytes memory data
    ) internal {
        assembly {
            let d := add(data, 0x20)

            // morpho-like pool as target
            let pool := shr(96, mload(d))
            // length of params
            let calldataLength := and(UINT16_MASK, shr(240, mload(add(d, 20))))

            let ptr := mload(0x40)

            // flashLoan(...)
            mstore(ptr, 0xe0232b4200000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), asset)
            mstore(add(ptr, 36), amount)
            mstore(add(ptr, 68), 0x60) // offset
            mstore(add(ptr, 100), add(20, calldataLength)) // data length
            mstore(add(ptr, 132), shl(96, orderSigner)) // caller

            // memory-to-memory copy of params
            let src := add(d, 22)
            let dest := add(ptr, 152)
            for { let i := 0 } lt(i, calldataLength) { i := add(i, 32) } {
                mstore(add(dest, i), mload(add(src, i)))
            }

            if iszero(
                call(
                    gas(),
                    pool,
                    0x0,
                    ptr,
                    add(calldataLength, 152),
                    0x0,
                    0x0
                )
            ) {
                returndatacopy(0, 0, returndatasize())
                revert(0x0, returndatasize())
            }
        }
    }
}
