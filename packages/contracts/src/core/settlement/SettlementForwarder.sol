// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

/**
 * @title SettlementForwarder
 * @notice Minimal execution sandbox for solver-provided calldata.
 *         Has NO token approvals — isolates the settlement contract
 *         from arbitrary external calls that could drain user allowances.
 */
contract SettlementForwarder {
    address public immutable settlement;

    error OnlySettlement();

    constructor(address _settlement) {
        settlement = _settlement;
    }

    /// @notice Execute arbitrary calldata in this contract's context.
    /// @param target The contract to call (e.g., DEX router)
    /// @param data The calldata to forward
    function execute(address target, bytes calldata data) external payable {
        if (msg.sender != settlement) revert OnlySettlement();
        assembly {
            calldatacopy(0, data.offset, data.length)
            if iszero(call(gas(), target, callvalue(), 0, data.length, 0, 0)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }

    /// @notice Sweep full ERC20 balance back to the settlement contract.
    /// @param token The ERC20 token to sweep
    function sweep(address token) external {
        if (msg.sender != settlement) revert OnlySettlement();
        address _settlement = settlement;
        assembly {
            // balanceOf(address(this))
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(4, address())
            if iszero(staticcall(gas(), token, 0, 0x24, 0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            let bal := mload(0)
            if gt(bal, 0) {
                // transfer(settlement, bal)
                mstore(0, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
                mstore(4, _settlement)
                mstore(0x24, bal)
                if iszero(call(gas(), token, 0, 0, 0x44, 0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }
        }
    }

    /// @notice Accept ETH for native token swaps
    receive() external payable {}
}
