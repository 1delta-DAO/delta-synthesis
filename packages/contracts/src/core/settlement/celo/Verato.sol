// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {IERC20} from "lib/forge-std/src/interfaces/IERC20.sol";
import {MorphoFlashLoans} from "../flash-loan/Morpho.sol";
import {MorphoSettlementCallback} from "../flash-loan/MorphoSettlementCallback.sol";
import {EIP712OrderVerifier} from "../EIP712OrderVerifier.sol";
import {SwapVerifier} from "../oracle/SwapVerifier.sol";
import {HealthFactorChecker} from "../conditions/HealthFactorChecker.sol";
import {LenderIds} from "../lending/DeltaEnums.sol";
import {SettlementForwarder} from "../SettlementForwarder.sol";
import {SettlementExecutor} from "../SettlementExecutor.sol";
import {IIdentityRegistry} from "../../../interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "../../../interfaces/IReputationRegistry.sol";

/**
 * @title Verato
 * @notice Autonomous lending-position settlement on Celo.
 *
 *  Users sign EIP-712 orders that commit to:
 *    - A Merkle root of allowed lending operations (deposit, borrow, repay, withdraw)
 *    - Oracle-verified swap conversions with user-signed slippage tolerance
 *    - Post-settlement health-factor conditions per touched protocol
 *    - A maximum fee the solver may extract from borrow surplus
 *    - Solver trust requirements (direct address + reputation threshold)
 *
 *  Solvers (agents) execute these orders via settle() or settleWithFlashLoan().
 *  Trust is fully embedded in the signed order — no storage-based permissioning:
 *
 *    solver = address(0), minSolverReputation = 0   → permissionless
 *    solver = address(0), minSolverReputation = 500 → any solver with rep ≥ 500
 *    solver = 0xABC,      minSolverReputation = 0   → direct trust (only 0xABC)
 *    solver = 0xABC,      minSolverReputation = 500 → 0xABC AND rep ≥ 500
 *
 *  The contract owner may set a global minReputation floor that applies
 *  regardless of what orders specify (effective min = max(order, global)).
 *
 *  Solver identity is backed by Celo ERC-8004 registries:
 *    - identityRegistry: NFT ownership proves on-chain identity
 *    - reputationRegistry: on-chain reputation score per agentId
 */
contract Verato is
    MorphoFlashLoans,
    MorphoSettlementCallback,
    EIP712OrderVerifier,
    SwapVerifier,
    HealthFactorChecker
{
    // ═════════════════════════════════════════════════════════════════════════
    //  Constants
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Morpho Blue canonical CREATE2 address.
    address internal constant MORPHO_BLUE = 0xd24ECdD8C1e0E57a4E26B1a7bbeAa3e95466A569;

    // ═════════════════════════════════════════════════════════════════════════
    //  Immutables
    // ═════════════════════════════════════════════════════════════════════════

    SettlementForwarder public immutable forwarder;
    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;

    // ═════════════════════════════════════════════════════════════════════════
    //  State
    // ═════════════════════════════════════════════════════════════════════════

    address public owner;

    /// @notice Global reputation floor. Effective minimum for any order is
    ///         max(order.minSolverReputation, minReputation).
    uint256 public minReputation;

    /// @notice Solver address → linked ERC-8004 agent ID.
    mapping(address => uint256) public solverAgentId;
    mapping(address => bool) public solverLinked;

    // ═════════════════════════════════════════════════════════════════════════
    //  Events
    // ═════════════════════════════════════════════════════════════════════════

    event OwnershipTransferred(address indexed prev, address indexed next);
    event MinReputationUpdated(uint256 newMin);
    event SolverLinked(address indexed solver, uint256 indexed agentId);

    // ═════════════════════════════════════════════════════════════════════════
    //  Errors
    // ═════════════════════════════════════════════════════════════════════════

    error ConversionMismatch();
    error UnsupportedConditionLender();
    error OnlyOwner();
    error SolverNotRegistered();
    error SolverReputationTooLow();
    error SolverNotLinked();

    // ═════════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═════════════════════════════════════════════════════════════════════════

    constructor(
        address _identityRegistry,
        address _reputationRegistry
    ) {
        identityRegistry = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        owner = msg.sender;
        forwarder = new SettlementForwarder(address(this));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Morpho Blue
    // ═════════════════════════════════════════════════════════════════════════

    function _morphoPool() internal pure override returns (address) {
        return MORPHO_BLUE;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Owner management
    // ═════════════════════════════════════════════════════════════════════════

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OnlyOwner();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Set the global reputation floor. Orders whose minSolverReputation
    ///         is below this value will use this floor instead.
    function setMinReputation(uint256 _minReputation) external {
        if (msg.sender != owner) revert OnlyOwner();
        minReputation = _minReputation;
        emit MinReputationUpdated(_minReputation);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Solver identity linking
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Solvers call this to link their address to an ERC-8004 agent ID.
    ///         Required before executing orders that set minSolverReputation > 0.
    function linkSolverAgentId(uint256 agentId) external {
        if (identityRegistry.balanceOf(msg.sender) == 0) revert SolverNotRegistered();
        solverAgentId[msg.sender] = agentId;
        solverLinked[msg.sender] = true;
        emit SolverLinked(msg.sender, agentId);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Settlement entry points
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Execute a signed settlement order directly (no flash loan).
    function settle(
        uint256 maxFeeBps, address solver, uint256 minSolverReputation, uint48 deadline,
        bytes calldata signature, bytes calldata orderData,
        bytes calldata executionData, bytes calldata fillerCalldata
    ) external {
        (address user,) = _verifyAndExtract(maxFeeBps, solver, minSolverReputation, deadline, signature, orderData);
        _checkSolverReputation(msg.sender, minSolverReputation);
        _executeSettlement(user, maxFeeBps, orderData, executionData, fillerCalldata);
    }

    /// @notice Execute a signed settlement order using a Morpho Blue flash loan.
    function settleWithFlashLoan(
        address flashLoanAsset, uint256 flashLoanAmount, address flashLoanPool, uint8 poolId,
        uint256 maxFeeBps, address solver, uint256 minSolverReputation, uint48 deadline,
        bytes calldata signature, bytes calldata orderData,
        bytes calldata executionData, bytes calldata fillerCalldata
    ) external {
        (address user,) = _verifyAndExtract(maxFeeBps, solver, minSolverReputation, deadline, signature, orderData);
        _checkSolverReputation(msg.sender, minSolverReputation);
        uint256 paramsLen = 1 + 8 + 2 + orderData.length + 2 + fillerCalldata.length + executionData.length;
        bytes memory fullData = abi.encodePacked(
            flashLoanPool, uint16(paramsLen), poolId, uint64(maxFeeBps),
            uint16(orderData.length), orderData,
            uint16(fillerCalldata.length), fillerCalldata, executionData
        );
        morphoFlashLoan(flashLoanAsset, flashLoanAmount, user, fullData);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Order verification
    // ═════════════════════════════════════════════════════════════════════════

    function _verifyAndExtract(
        uint256 maxFeeBps, address solver, uint256 minSolverReputation, uint48 deadline,
        bytes calldata signature, bytes calldata orderData
    ) internal view returns (address user, bytes32 merkleRoot) {
        bytes memory settlementData;
        assembly {
            merkleRoot := calldataload(orderData.offset)
            let sLen := shr(240, calldataload(add(orderData.offset, 32)))
            let fmp := mload(0x40)
            settlementData := fmp
            mstore(fmp, sLen)
            calldatacopy(add(fmp, 0x20), add(orderData.offset, 34), sLen)
            mstore(0x40, add(add(fmp, 0x20), and(add(sLen, 31), not(31))))
        }
        user = _recoverOrderSigner(merkleRoot, deadline, maxFeeBps, solver, minSolverReputation, settlementData, signature);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Intent: oracle-verified swaps
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * @notice Execute solver-provided swaps, each verified against a user-signed conversion.
     *
     * fillerCalldata layout: [1: numSwaps][swap0...][swap1...]
     * Each swap: [1: conversionIndex][14: amountIn][20: target][2: calldataLen][calldata...]
     *
     * The conversionIndex references the conversion in settlementData (0-based).
     * assetIn/assetOut are read from the referenced conversion — no duplication.
     */
    function _executeIntent(
        address, bytes memory settlementData, bytes memory fillerCalldata,
        AssetDelta[] memory deltas, uint256 deltaCount
    ) internal override returns (uint256 newDeltaCount) {
        if (fillerCalldata.length == 0) return deltaCount;
        newDeltaCount = deltaCount;

        uint256 numSwaps;
        assembly { numSwaps := shr(248, mload(add(fillerCalldata, 0x20))) }

        uint256 fcOffset = 1; // skip numSwaps byte
        for (uint256 i; i < numSwaps;) {
            uint256 fcLen;
            (newDeltaCount, fcLen) = _executeSwap(settlementData, fillerCalldata, fcOffset, deltas, newDeltaCount);
            fcOffset += fcLen;
            unchecked { ++i; }
        }
    }

    /**
     * @notice Execute a single filler swap using a conversion index.
     *
     * Filler swap layout: [1: convIndex][14: amountIn][20: target][2: calldataLen][calldata...]
     * Total header: 37 bytes (was 76 — saves 39 bytes per swap by eliminating redundant addresses)
     */
    function _executeSwap(
        bytes memory settlementData,
        bytes memory fillerCalldata, uint256 fcOffset,
        AssetDelta[] memory deltas, uint256 deltaCount
    ) private returns (uint256 newDeltaCount, uint256 fcConsumed) {
        uint256 convIndex; uint256 amountIn; address target; uint256 swapCalldataLen;
        assembly {
            let fc := add(add(fillerCalldata, 0x20), fcOffset)
            convIndex := shr(248, mload(fc))
            amountIn := shr(144, mload(add(fc, 1)))
            target := shr(96, mload(add(fc, 15)))
            swapCalldataLen := and(0xffff, shr(240, mload(add(fc, 35))))
        }

        // Read conversion from settlementData at the specified index
        // Layout: [1: numConversions][68 bytes per conversion: assetIn|assetOut|oracle|tolerance]
        address assetIn; address assetOut; address oracle; uint256 swapTolerance;
        assembly {
            let sd := add(add(settlementData, 0x20), add(1, mul(convIndex, 68)))
            assetIn := shr(96, mload(sd))
            assetOut := shr(96, mload(add(sd, 20)))
            oracle := shr(96, mload(add(sd, 40)))
            swapTolerance := shr(192, mload(add(sd, 60)))
        }

        // Resolve amountIn if zero (use contract balance)
        if (amountIn == 0) {
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 4), address())
                if iszero(staticcall(gas(), assetIn, ptr, 0x24, ptr, 0x20)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
                amountIn := mload(ptr)
            }
            if (amountIn == 0) { return (deltaCount, 37 + swapCalldataLen); }
        }
        uint256 amountOut = _forwardSwap(assetIn, assetOut, amountIn, target, fillerCalldata, fcOffset, swapCalldataLen);
        _verifySwapOutput(oracle, assetIn, assetOut, amountIn, amountOut, swapTolerance);
        newDeltaCount = _updateDelta(deltas, deltaCount, assetIn, -int256(amountIn), 0);
        newDeltaCount = _updateDelta(deltas, newDeltaCount, assetOut, int256(amountOut), 0);
        fcConsumed = 37 + swapCalldataLen;
    }

    function _forwardSwap(
        address assetIn, address assetOut, uint256 amountIn, address target,
        bytes memory fillerCalldata, uint256 fcOffset, uint256 swapCalldataLen
    ) private returns (uint256 amountOut) {
        address payable fwd = payable(address(forwarder));
        uint256 balBefore;
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), address())
            if iszero(staticcall(gas(), assetOut, ptr, 0x24, ptr, 0x20)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
            balBefore := mload(ptr)
        }
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), fwd)
            mstore(add(ptr, 0x24), amountIn)
            if iszero(call(gas(), assetIn, 0, ptr, 0x44, 0, 0x20)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
        }
        bytes memory swapCalldata = new bytes(swapCalldataLen);
        assembly {
            let src := add(add(fillerCalldata, 0x20), add(fcOffset, 37))
            let dest := add(swapCalldata, 0x20)
            for { let j := 0 } lt(j, swapCalldataLen) { j := add(j, 32) } { mstore(add(dest, j), mload(add(src, j))) }
        }
        // Approve the swap target to spend assetIn from the forwarder
        bytes memory approveCalldata = abi.encodeWithSelector(0x095ea7b3, target, amountIn);
        SettlementForwarder(fwd).execute(assetIn, approveCalldata);
        SettlementForwarder(fwd).execute(target, swapCalldata);
        SettlementForwarder(fwd).sweep(assetOut);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), address())
            if iszero(staticcall(gas(), assetOut, ptr, 0x24, ptr, 0x20)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
            amountOut := sub(mload(ptr), balBefore)
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Post-settlement conditions
    // ═════════════════════════════════════════════════════════════════════════

    function _postSettlementCheck(
        address orderSigner, bytes memory settlementData, uint256 riskyLenderMask
    ) internal view override {
        uint256 numConversions;
        assembly { numConversions := shr(248, mload(add(settlementData, 0x20))) }
        uint256 conditionsOffset = 1 + numConversions * 68;
        if (settlementData.length <= conditionsOffset) return;
        uint256 numConditions;
        assembly { numConditions := shr(248, mload(add(add(settlementData, 0x20), conditionsOffset))) }
        uint256 cursor = conditionsOffset + 1;
        for (uint256 i; i < numConditions;) {
            uint256 lenderId;
            assembly { lenderId := and(0xffff, shr(240, mload(add(add(settlementData, 0x20), cursor)))) }
            if (lenderId < LenderIds.UP_TO_AAVE_V2) {
                if (riskyLenderMask & 1 != 0) {
                    address pool; uint256 minHF;
                    assembly { let ptr := add(add(settlementData, 0x20), cursor) pool := shr(96, mload(add(ptr, 2))) minHF := shr(144, mload(add(ptr, 22))) }
                    _checkAaveHealthFactor(pool, orderSigner, minHF);
                }
                cursor += 36;
            } else if (lenderId < LenderIds.UP_TO_COMPOUND_V3) {
                if (riskyLenderMask & 2 != 0) {
                    address comet; uint256 assetBitmap; uint256 minHF;
                    assembly { let ptr := add(add(settlementData, 0x20), cursor) comet := shr(96, mload(add(ptr, 2))) assetBitmap := and(0xffff, shr(240, mload(add(ptr, 22)))) minHF := shr(144, mload(add(ptr, 24))) }
                    _checkCompoundV3HealthFactor(comet, orderSigner, assetBitmap, minHF);
                }
                cursor += 38;
            } else if (lenderId < LenderIds.UP_TO_COMPOUND_V2) {
                if (riskyLenderMask & 4 != 0) {
                    address comptroller;
                    assembly { let ptr := add(add(settlementData, 0x20), cursor) comptroller := shr(96, mload(add(ptr, 2))) }
                    _checkCompoundV2Solvency(comptroller, orderSigner);
                }
                cursor += 36;
            } else if (lenderId < LenderIds.UP_TO_MORPHO) {
                if (riskyLenderMask & 8 != 0) {
                    address morpho; bytes32 marketId; uint256 minHF;
                    assembly { let ptr := add(add(settlementData, 0x20), cursor) morpho := shr(96, mload(add(ptr, 2))) marketId := mload(add(ptr, 22)) minHF := shr(144, mload(add(ptr, 54))) }
                    _checkMorphoHealthFactor(morpho, marketId, orderSigner, minHF);
                }
                cursor += 68;
            } else {
                revert UnsupportedConditionLender();
            }
            unchecked { ++i; }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Internal — solver reputation
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Checks solver reputation using the order-embedded threshold.
    ///         When the effective minimum (max of order and global) is 0,
    ///         the check is skipped — the user trusts any solver (or trusts
    ///         the specific solver named in the order's `solver` field).
    function _checkSolverReputation(address solver, uint256 orderMinReputation) internal view {
        uint256 required = orderMinReputation > minReputation ? orderMinReputation : minReputation;
        if (required == 0) return;
        if (!solverLinked[solver]) revert SolverNotLinked();
        if (identityRegistry.balanceOf(solver) == 0) revert SolverNotRegistered();
        uint256 agentId = solverAgentId[solver];
        IReputationRegistry.Summary memory summary = reputationRegistry.getSummary(agentId);
        if (summary.averageScore < required) revert SolverReputationTooLow();
    }
}
