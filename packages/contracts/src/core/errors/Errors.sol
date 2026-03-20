// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

abstract contract DeltaErrors {
    error InvalidOperation();
    error InvalidFlashLoan();
    error InvalidCaller();

    // InvalidFlashLoan()
    bytes4 internal constant INVALID_FLASH_LOAN = 0xbafe1c53;
    // InvalidCaller()
    bytes4 internal constant INVALID_CALLER = 0x48f5c3ed;
    // InvalidOperation()
    bytes4 internal constant INVALID_OPERATION = 0x398d4d32;

    function _invalidOperation() internal pure {
        assembly {
            mstore(0, 0x398d4d32)
            revert(0, 0x4)
        }
    }
}
