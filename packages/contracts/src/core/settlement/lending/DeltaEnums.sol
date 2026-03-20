// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

/**
 * Permit classifier enums
 */
library TransferIds {
    uint256 internal constant TRANSFER_FROM = 0;
    uint256 internal constant SWEEP = 1;
    uint256 internal constant WRAP_NATIVE = 2;
    uint256 internal constant UNWRAP_WNATIVE = 3;
    uint256 internal constant PERMIT2_TRANSFER_FROM = 4;
    uint256 internal constant APPROVE = 5;
    // we add this for cases where the receive function does not forward 'wrap'
    uint256 internal constant WRAP = 6;
}

/**
 * Permit classifier enums
 */
library PermitIds {
    uint256 internal constant TOKEN_PERMIT = 0;
    uint256 internal constant AAVE_V3_CREDIT_PERMIT = 1;
    uint256 internal constant ALLOW_CREDIT_PERMIT = 2;
}

/**
 * @notice Lender classifier enums defining protocol ID boundaries.
 * @dev Each value represents an exclusive upper bound. A lender ID is routed to the protocol
 *      whose UP_TO_* constant is the smallest value greater than the ID.
 *      Example: lenderId=500 -> Aave V3 (500 < 1000), lenderId=1500 -> Aave V2 (1500 < 2000)
 */
library LenderIds {
    uint256 internal constant UP_TO_AAVE_V3 = 1000;
    uint256 internal constant UP_TO_AAVE_V2 = 2000;
    uint256 internal constant UP_TO_COMPOUND_V3 = 3000;
    uint256 internal constant UP_TO_COMPOUND_V2 = 4000;
    uint256 internal constant UP_TO_MORPHO = 5000;
}

/**
 * @notice Lending operation type enums, encoded as uint8 in calldata.
 * @dev DEPOSIT_LENDING_TOKEN and WITHDRAW_LENDING_TOKEN are Morpho-specific operations
 *      for supplying/withdrawing the loan token (as opposed to collateral).
 */
library LenderOps {
    uint256 internal constant DEPOSIT = 0;
    uint256 internal constant BORROW = 1;
    uint256 internal constant REPAY = 2;
    uint256 internal constant WITHDRAW = 3;
    uint256 internal constant DEPOSIT_LENDING_TOKEN = 4;
    uint256 internal constant WITHDRAW_LENDING_TOKEN = 5;
}

/**
 * Lender classifier enums, expected to be encoded as uint16
 */
library FlashLoanIds {
    uint256 internal constant MORPHO = 0;
    uint256 internal constant BALANCER_V2 = 1;
    uint256 internal constant AAVE_V3 = 2;
    uint256 internal constant AAVE_V2 = 3;
}

/**
 * ERC4626 classifier enums
 */
library ERC4626Ids {
    uint256 internal constant DEPOSIT = 0;
    uint256 internal constant WITHDRAW = 1;
}

/**
 * Uniswp V4 operations outside of swaps
 */
library Gen2025ActionIds {
    uint256 internal constant UNLOCK = 0;
    uint256 internal constant UNI_V4_TAKE = 1;
    uint256 internal constant UNI_V4_SETTLE = 2;
    uint256 internal constant UNI_V4_SYNC = 3;
    uint256 internal constant BAL_V3_TAKE = 4;
    uint256 internal constant BAL_V3_SETTLE = 5;
}

/// @title Commands for OneDeltaComposer
library ComposerCommands {
    uint256 internal constant SWAPS = 0x10;
    uint256 internal constant EXT_CALL = 0x20;
    uint256 internal constant EXT_TRY_CALL = 0x21;
    uint256 internal constant EXT_CALL_WITH_REPLACE = 0x22;
    uint256 internal constant EXT_TRY_CALL_WITH_REPLACE = 0x23;
    uint256 internal constant LENDING = 0x30;
    uint256 internal constant TRANSFERS = 0x40;
    uint256 internal constant PERMIT = 0x50;
    uint256 internal constant FLASH_LOAN = 0x60;
    uint256 internal constant ERC4626 = 0x70;
    uint256 internal constant GEN_2025_SINGELTONS = 0x80;
    uint256 internal constant BRIDGING = 0x90;
}

/// @title Commands for Bridge
library BridgeIds {
    uint256 internal constant STARGATE_V2 = 0x00;
    uint256 internal constant ACROSS = 0x0A;
    uint256 internal constant SQUID_ROUTER = 0x14;
    uint256 internal constant GASZIP = 0x1E;
}

library CompoundV2Selector {
    uint256 internal constant MINT_BEHALF = 0;
    uint256 internal constant MINT = 1;
    uint256 internal constant MINT_ITOKEN = 2;

    uint256 internal constant REDEEM = 0;
    uint256 internal constant REDEEM_BEHALF = 1;
    uint256 internal constant REDEEM_ITOKEN = 2;
}

