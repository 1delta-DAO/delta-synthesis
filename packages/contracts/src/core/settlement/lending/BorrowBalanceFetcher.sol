// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {ERC20Selectors} from "../../selectors/ERC20Selectors.sol";
import {Masks} from "../../masks/Masks.sol";

/**
 * @title BorrowBalanceFetcher
 * @notice Read-only helpers to fetch a user's borrow (debt) bal across lending protocols.
 * @dev Each function uses low-level staticcall to query the respective protocol's on-chain state.
 *      These are intended for off-chain consumption or view-context calls to check debt positions
 *      before constructing settlement data blobs.
 */
abstract contract BorrowBalanceFetcher is ERC20Selectors, Masks {
    /**
     * @notice Fetches a user's debt token bal on Aave V2/V3.
     * @dev Works for both variable and stable debt tokens. Pass the appropriate debt token address.
     * @param user The borrower address
     * @param debtToken The variable or stable debt token contract address
     * @return bal The user's outstanding debt bal
     */
    function _getAaveBorrowBalance(address user, address debtToken) internal view returns (uint256 bal) {
        assembly {
            mstore(0x0, ERC20_BALANCE_OF)
            mstore(0x04, user)
            if iszero(staticcall(gas(), debtToken, 0x0, 0x24, 0x0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            bal := mload(0x0)
        }
    }

    /**
     * @notice Fetches a user's borrow bal on Compound V2.
     * @dev Calls `borrowBalanceCurrent(address)` which accrues interest before returning.
     *      Note: this is NOT a pure view on Compound V2 — use via eth_call for read-only access.
     * @param user The borrower address
     * @param cToken The cToken contract address
     * @return bal The user's current borrow bal including accrued interest
     */
    function _getCompoundV2BorrowBalance(address user, address cToken) internal view returns (uint256 bal) {
        assembly {
            // borrowBalanceCurrent(address)
            mstore(0x0, 0x17bfdfbc00000000000000000000000000000000000000000000000000000000)
            mstore(0x04, user)
            if iszero(staticcall(gas(), cToken, 0x0, 0x24, 0x0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            bal := mload(0x0)
        }
    }

    /**
     * @notice Fetches a user's borrow bal on Compound V3 (Comet).
     * @param user The borrower address
     * @param comet The Comet (Compound V3) contract address
     * @return bal The user's current borrow bal
     */
    function _getCompoundV3BorrowBalance(address user, address comet) internal view returns (uint256 bal) {
        assembly {
            // borrowBalanceOf(address)
            mstore(0x0, 0x374c49b400000000000000000000000000000000000000000000000000000000)
            mstore(0x04, user)
            if iszero(staticcall(gas(), comet, 0x0, 0x24, 0x0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            bal := mload(0x0)
        }
    }

    /**
     * @notice Fetches a user's borrow shares on Morpho Blue.
     * @dev Returns raw borrow shares — convert to assets using market totals if needed.
     * @param user The borrower address
     * @param morpho The Morpho Blue contract address
     * @param loanToken The market's loan token
     * @param collateralToken The market's collateral token
     * @param oracle The market's oracle
     * @param irm The market's interest rate model
     * @param lltv The market's liquidation LTV
     * @return borrowShares The user's borrow shares
     */
    function _getMorphoBorrowShares(
        address user,
        address morpho,
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv
    ) internal view returns (uint256 borrowShares) {
        assembly {
            let ptr := mload(0x40)

            // build market params for hashing
            mstore(ptr, loanToken)
            mstore(add(ptr, 0x20), collateralToken)
            mstore(add(ptr, 0x40), oracle)
            mstore(add(ptr, 0x60), irm)
            mstore(add(ptr, 0x80), lltv)
            let marketId := keccak256(ptr, 160)

            // position(bytes32,address) -> (uint256 supplyShares, uint128 borrowShares, uint128 collateral)
            mstore(ptr, 0x93c5206200000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), marketId)
            mstore(add(ptr, 0x24), user)
            if iszero(staticcall(gas(), morpho, ptr, 0x44, ptr, 0x60)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            // borrowShares is the 2nd return value
            borrowShares := mload(add(ptr, 0x20))
        }
    }

}
