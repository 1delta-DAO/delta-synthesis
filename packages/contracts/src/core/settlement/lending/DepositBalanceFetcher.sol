// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {ERC20Selectors} from "../../selectors/ERC20Selectors.sol";
import {Masks} from "../../masks/Masks.sol";

/**
 * @title DepositBalanceFetcher
 * @notice Read-only helpers to fetch a user's deposit (supply/collateral) bal across lending protocols.
 * @dev Each function uses low-level staticcall to query the respective protocol's on-chain state.
 *      These are intended for off-chain consumption or view-context calls to check positions
 *      before constructing settlement data blobs.
 */
abstract contract DepositBalanceFetcher is ERC20Selectors, Masks {
    /**
     * @notice Fetches a user's aToken bal (deposit bal) on Aave V2/V3.
     * @param user The depositor address
     * @param aToken The aToken contract address
     * @return bal The user's aToken bal (1:1 with underlying deposited)
     */
    function _getAaveDepositBalance(address user, address aToken) internal view returns (uint256 bal) {
        assembly {
            mstore(0x0, ERC20_BALANCE_OF)
            mstore(0x04, user)
            if iszero(staticcall(gas(), aToken, 0x0, 0x24, 0x0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            bal := mload(0x0)
        }
    }

    /**
     * @notice Fetches a user's underlying deposit bal on Compound V2.
     * @dev Calls `balOfUnderlying(address)` which accounts for the exchange rate.
     *      Note: this is NOT a view function on Compound V2 — it accrues interest.
     *      Use in a staticcall context for read-only access (eth_call).
     * @param user The depositor address
     * @param cToken The cToken contract address
     * @return bal The user's underlying deposit bal
     */
    function _getCompoundV2DepositBalance(address user, address cToken) internal view returns (uint256 bal) {
        assembly {
            // balOfUnderlying(address)
            mstore(0x0, 0x3af9e66900000000000000000000000000000000000000000000000000000000)
            mstore(0x04, user)
            if iszero(staticcall(gas(), cToken, 0x0, 0x24, 0x0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            bal := mload(0x0)
        }
    }

    /**
     * @notice Fetches a user's deposit bal on Compound V3 (base asset or collateral).
     * @param user The depositor address
     * @param asset The underlying asset address (only used for collateral lookup)
     * @param comet The Comet (Compound V3) contract address
     * @param isBase True if querying the base asset bal, false for collateral
     * @return bal The user's deposit bal
     */
    function _getCompoundV3DepositBalance(
        address user,
        address asset,
        address comet,
        bool isBase
    ) internal view returns (uint256 bal) {
        assembly {
            let ptr := mload(0x40)
            switch isBase
            case 0 {
                // userCollateral(address,address) -> returns (uint128 bal, uint128 _reserved)
                mstore(ptr, 0x2b92a07d00000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 0x04), user)
                mstore(add(ptr, 0x24), asset)
                if iszero(staticcall(gas(), comet, ptr, 0x44, ptr, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                bal := and(UINT128_MASK, mload(ptr))
            }
            default {
                // balOf(address) for base asset
                mstore(0x0, ERC20_BALANCE_OF)
                mstore(0x04, user)
                if iszero(staticcall(gas(), comet, 0x0, 0x24, 0x0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                bal := mload(0x0)
            }
        }
    }

    /**
     * @notice Fetches a user's collateral bal on Morpho Blue.
     * @dev Reads position(marketId, user) from the Morpho contract. The marketId is derived
     *      by hashing the market params (loanToken, collateralToken, oracle, irm, lltv).
     * @param user The depositor address
     * @param morpho The Morpho Blue contract address
     * @param loanToken The market's loan token
     * @param collateralToken The market's collateral token
     * @param oracle The market's oracle
     * @param irm The market's interest rate model
     * @param lltv The market's liquidation LTV
     * @return bal The user's collateral bal
     */
    function _getMorphoCollateralBalance(
        address user,
        address morpho,
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv
    ) internal view returns (uint256 bal) {
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
            // collateral is the 3rd return value
            bal := mload(add(ptr, 0x40))
        }
    }

    /**
     * @notice Fetches a user's supply shares on Morpho Blue.
     * @dev Returns raw supply shares — convert to assets using market totals if needed.
     * @param user The depositor address
     * @param morpho The Morpho Blue contract address
     * @param loanToken The market's loan token
     * @param collateralToken The market's collateral token
     * @param oracle The market's oracle
     * @param irm The market's interest rate model
     * @param lltv The market's liquidation LTV
     * @return supplyShares The user's supply shares
     */
    function _getMorphoSupplyShares(
        address user,
        address morpho,
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv
    ) internal view returns (uint256 supplyShares) {
        assembly {
            let ptr := mload(0x40)

            mstore(ptr, loanToken)
            mstore(add(ptr, 0x20), collateralToken)
            mstore(add(ptr, 0x40), oracle)
            mstore(add(ptr, 0x60), irm)
            mstore(add(ptr, 0x80), lltv)
            let marketId := keccak256(ptr, 160)

            // position(bytes32,address)
            mstore(ptr, 0x93c5206200000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), marketId)
            mstore(add(ptr, 0x24), user)
            if iszero(staticcall(gas(), morpho, ptr, 0x44, ptr, 0x60)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            // supplyShares is the 1st return value
            supplyShares := mload(ptr)
        }
    }

}
