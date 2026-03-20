// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {UniversalSettlementLending} from "./lending/UniversalSettlementLending.sol";

/**
 * @title SettlementExecutor
 * @notice Orchestrates three-phase lending settlements with merkle-verified actions,
 *         per-asset zero-sum accounting, and a percentage-based solver fee that
 *         can only be charged on borrowed assets.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SOLVER FEE — BORROW-ONLY, PERCENTAGE-BASED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  The user signs `maxFeeBps` as part of the EIP-712 order — the maximum
 *  fee as a fraction of the total amount borrowed.
 *  Denominator is 1e7 (sub-basis-point precision):
 *
 *      100% = 1e7    |  1 bps = 1 000    |  0.01 bps = 10
 *
 *  After all three phases the executor checks each asset's delta:
 *
 *    • delta > 0, totalBorrowed > 0 → borrow surplus = fee
 *        Verified: surplus × 1e7 ≤ totalBorrowed × maxFeeBps
 *        Transferred to feeRecipient.
 *    • delta > 0, totalBorrowed == 0 → non-borrow surplus → ignored (stays in contract)
 *    • delta < 0                     → deficit → revert (UnbalancedSettlement)
 *    • delta == 0                    → balanced → ok
 *
 *  Non-borrow surpluses are not swept to the user — they stay in the
 *  contract.  The solver should deposit excess into a lender for the
 *  user via post-actions so funds remain in lending protocols.
 *
 *  Example with maxFeeBps = 50 000 (0.5%), borrow 1000 USDC:
 *    max fee = 1000 × 50 000 / 1e7 = 5 USDC
 *    solver borrows 1005, repays 1000, keeps 5 ✓
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DATA LAYOUTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * @dev Order data (signed by user):
 *   [32: merkleRoot][2: settlementDataLength][settlementData]
 *
 * @dev Execution data (solver-provided):
 *   [1: numPre][1: numPost][20: feeRecipient]
 *   [per action]:
 *       [20: asset][14: amount][20: receiver]          — variable params (54 B)
 *       [1: op][2: lender][2: dataLen][data]           — action config
 *       [1: proofLen][proofLen × 32: proof siblings]   — merkle proof
 *
 * @dev Amount sentinels:
 *   0                 — contract's current token balance
 *   type(uint112).max — protocol-specific "safe max" (full user position)
 */
abstract contract SettlementExecutor is UniversalSettlementLending {
    // ── Errors ──────────────────────────────────────────────

    /// @dev Merkle proof does not reconstruct the signed root.
    error InvalidMerkleProof();

    /// @dev An asset has a negative delta (deficit).
    error UnbalancedSettlement();

    /// @dev Borrow surplus exceeds the user-signed percentage cap.
    error FeeExceedsMax();

    // ── Constants ───────────────────────────────────────────

    /// @dev LenderOps.BORROW — must match DeltaEnums.sol
    uint256 private constant OP_BORROW = 1;

    /// @dev LenderOps.WITHDRAW — must match DeltaEnums.sol
    uint256 private constant OP_WITHDRAW = 3;

    /// @dev LenderOps.WITHDRAW_LENDING_TOKEN — must match DeltaEnums.sol
    uint256 private constant OP_WITHDRAW_LENDING_TOKEN = 5;

    /// @dev Fee denominator — allows sub-basis-point precision.
    ///      100% = 1e7.  1 bps = 1 000.  0.01 bps = 10.  1 unit = 0.0001 bps.
    uint256 private constant FEE_DENOMINATOR = 1e7;

    // ── Types ───────────────────────────────────────────────

    /**
     * @notice Per-asset accounting entry.
     * @param asset          Token address (from lending operation's `assetUsed`).
     * @param delta          Signed net flow.  Positive = surplus, negative = deficit.
     * @param totalBorrowed  Gross amount received via BORROW ops on this asset.
     *                       Used as the denominator for the percentage fee check.
     *                       Zero means this asset was never borrowed — no fee allowed.
     */
    struct AssetDelta {
        address asset;
        int256 delta;
        uint256 totalBorrowed;
    }

    // ── Token Approvals ────────────────────────────────────

    /**
     * @notice Approve a spender to transfer tokens held by this contract.
     * @dev Permissionless — safe because the settlement contract never holds
     *      persistent balances.  Solvers can batch approvals with settlements
     *      via multicall.
     */
    function approveToken(address token, address spender, uint256 amount) external {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x095ea7b300000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), spender)
            mstore(add(ptr, 0x24), amount)

            let success := call(gas(), token, 0, ptr, 0x44, 0x00, 0x20)
            let rdsize := returndatasize()
            success := and(
                success,
                or(iszero(rdsize), and(gt(rdsize, 31), eq(mload(0x00), 1)))
            )
            if iszero(success) {
                returndatacopy(0, 0, rdsize)
                revert(0, rdsize)
            }
        }
    }

    /**
     * @notice Batch multiple calls into a single transaction.
     * @dev Enables solvers to bundle approvals with settlements:
     *      multicall([approveToken(USDC, pool, max), settleWithFlashLoan(...)])
     */
    function multicall(bytes[] calldata data) external {
        for (uint256 i; i < data.length;) {
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);
            if (!success) {
                assembly {
                    revert(add(result, 0x20), mload(result))
                }
            }
            unchecked { ++i; }
        }
    }

    // ── Signature-Based Authorizations ──────────────────────

    /**
     * @notice Forward an ERC-2612 permit to a token contract.
     * @dev Allows solvers to batch user permits with settlements via multicall.
     *      Silently succeeds if the permit reverts (e.g. already used nonce)
     *      so that multicall bundles remain idempotent.
     */
    function permit(
        address token,
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0xd505accf00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), owner)
            mstore(add(ptr, 0x24), spender)
            mstore(add(ptr, 0x44), value)
            mstore(add(ptr, 0x64), deadline)
            mstore(add(ptr, 0x84), v)
            mstore(add(ptr, 0xa4), r)
            mstore(add(ptr, 0xc4), s)
            // Best-effort: don't revert if permit fails (nonce already consumed, etc.)
            pop(call(gas(), token, 0, ptr, 0xe4, 0, 0))
        }
    }

    /**
     * @notice Forward a Morpho Blue setAuthorizationWithSig call.
     * @dev Allows solvers to bundle Morpho authorization with settlements.
     *
     * @param morpho     Morpho Blue contract address.
     * @param authorizer The user granting authorization.
     * @param authorized The address being authorized (typically this contract).
     * @param isAuthorized Whether to grant or revoke.
     * @param nonce      The authorizer's current nonce on Morpho.
     * @param deadline   Signature expiry timestamp.
     * @param v          Signature component.
     * @param r          Signature component.
     * @param s          Signature component.
     */
    function morphoSetAuthorizationWithSig(
        address morpho,
        address authorizer,
        address authorized,
        bool isAuthorized,
        uint256 nonce,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // setAuthorizationWithSig(Authorization(authorizer,authorized,isAuthorized,nonce,deadline), Signature(v,r,s))
        // Authorization struct is encoded inline (not as a tuple pointer for this low-level call)
        assembly {
            let ptr := mload(0x40)
            // setAuthorizationWithSig((address,address,bool,uint256,uint256),(uint8,bytes32,bytes32)) = 0x8069218f
            mstore(ptr, 0x8069218f00000000000000000000000000000000000000000000000000000000)
            // Authorization struct fields (5 × 32 bytes at offsets 0x04..0xa4)
            mstore(add(ptr, 0x04), authorizer)
            mstore(add(ptr, 0x24), authorized)
            mstore(add(ptr, 0x44), isAuthorized)
            mstore(add(ptr, 0x64), nonce)
            mstore(add(ptr, 0x84), deadline)
            // Signature struct fields (3 × 32 bytes at offsets 0xa4..0x104)
            mstore(add(ptr, 0xa4), v)
            mstore(add(ptr, 0xc4), r)
            mstore(add(ptr, 0xe4), s)
            // Best-effort
            pop(call(gas(), morpho, 0, ptr, 0x104, 0, 0))
        }
    }

    /**
     * @notice Forward a Compound V3 allowBySig call.
     * @dev Allows solvers to bundle Comet manager authorization with settlements.
     */
    function compoundV3AllowBySig(
        address comet,
        address owner,
        address manager,
        bool isAllowed,
        uint256 nonce,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // allowBySig(address,address,bool,uint256,uint256,uint8,bytes32,bytes32) = 0xbb24d994
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0xbb24d99400000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), owner)
            mstore(add(ptr, 0x24), manager)
            mstore(add(ptr, 0x44), isAllowed)
            mstore(add(ptr, 0x64), nonce)
            mstore(add(ptr, 0x84), expiry)
            mstore(add(ptr, 0xa4), v)
            mstore(add(ptr, 0xc4), r)
            mstore(add(ptr, 0xe4), s)
            // Best-effort
            pop(call(gas(), comet, 0, ptr, 0x104, 0, 0))
        }
    }

    /**
     * @notice Forward an Aave V3 delegationWithSig call to a debt token.
     * @dev Allows solvers to bundle credit delegation with settlements.
     */
    function aaveDelegationWithSig(
        address debtToken,
        address delegator,
        address delegatee,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // delegationWithSig(address,address,uint256,uint256,uint8,bytes32,bytes32)
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x0b52d55800000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), delegator)
            mstore(add(ptr, 0x24), delegatee)
            mstore(add(ptr, 0x44), value)
            mstore(add(ptr, 0x64), deadline)
            mstore(add(ptr, 0x84), v)
            mstore(add(ptr, 0xa4), r)
            mstore(add(ptr, 0xc4), s)
            // Best-effort
            pop(call(gas(), debtToken, 0, ptr, 0xe4, 0, 0))
        }
    }

    // ── Settlement entry point ──────────────────────────────

    /**
     * @notice Execute a full settlement and assert zero-sum balances.
     *
     * @param orderSigner  The order signer / position owner.
     * @param maxFeeBps      Maximum solver fee as a fraction of total borrow (user-signed).
     *                       Denominator is 1e7 (100% = 1e7, 1 bps = 1 000).
     *                       E.g. 50 000 = 0.5%, 500 = 0.005%.  Set to 0 for fee-free.
     * @param orderData      [32: merkleRoot][2: settlementLen][settlementData]
     * @param executionData  [1: numPre][1: numPost][20: feeRecipient][actions…]
     * @param fillerCalldata Forwarded to `_executeIntent` for DEX fills.
     */
    function _executeSettlement(
        address orderSigner,
        uint256 maxFeeBps,
        bytes memory orderData,
        bytes memory executionData,
        bytes memory fillerCalldata
    ) internal {
        bytes32 merkleRoot;
        bytes memory settlementData;

        assembly {
            let od := add(orderData, 0x20)
            merkleRoot := mload(od)
            let sLen := and(0xffff, shr(240, mload(add(od, 32))))

            // Copy settlementData into its own bytes memory
            let fmp := mload(0x40)
            settlementData := fmp
            mstore(fmp, sLen)
            let src := add(od, 34)
            let dest := add(fmp, 0x20)
            for { let j := 0 } lt(j, sLen) { j := add(j, 32) } {
                mstore(add(dest, j), mload(add(src, j)))
            }
            mstore(0x40, add(dest, and(add(sLen, 31), not(31))))
        }

        uint256 numPre;
        uint256 numPost;
        address feeRecipient;
        uint256 execOffset;

        assembly {
            let ed := add(executionData, 0x20)
            numPre := shr(248, mload(ed))
            numPost := shr(248, mload(add(ed, 1)))
            feeRecipient := shr(96, mload(add(ed, 2)))
            // header: 1 + 1 + 20 = 22 bytes
            execOffset := 22
        }

        AssetDelta[] memory deltas = new AssetDelta[](numPre + numPost);
        uint256 deltaCount;
        uint256 riskyLenderMask;

        // ── Stage 1: pre-actions ──
        (execOffset, deltaCount, riskyLenderMask) = _executeActions(
            orderSigner, merkleRoot, executionData, execOffset, numPre, deltas, deltaCount
        );

        // ── Stage 2: intent (optional conversion) ──
        deltaCount = _executeIntent(
            orderSigner, settlementData, fillerCalldata, deltas, deltaCount
        );

        {
            // ── Stage 3: post-actions ──
            uint256 postMask;
            (execOffset, deltaCount, postMask) = _executeActions(
                orderSigner, merkleRoot, executionData, execOffset, numPost, deltas, deltaCount
            );
            riskyLenderMask |= postMask;
        }

        // ── Stage 4: sweep borrow fees, verify no deficits ──
        _sweepAndVerify(deltas, deltaCount, orderSigner, feeRecipient, maxFeeBps);

        // ── Stage 5: post-settlement conditions (health factor, etc.) ──
        // Run for all lender buckets that were touched by any operation.
        if (riskyLenderMask != 0) {
            _postSettlementCheck(orderSigner, settlementData, riskyLenderMask);
        }
    }

    // ── Merkle-verified action batch ────────────────────────

    /**
     * @notice Parse, verify, execute, and account for a batch of lending actions.
     */
    function _executeActions(
        address orderSigner,
        bytes32 merkleRoot,
        bytes memory executionData,
        uint256 execOffset,
        uint256 count,
        AssetDelta[] memory deltas,
        uint256 deltaCount
    ) internal returns (uint256 newExecOffset, uint256 newDeltaCount, uint256 riskyLenderMask) {
        newExecOffset = execOffset;
        newDeltaCount = deltaCount;

        for (uint256 i; i < count;) {
            uint256 op;
            uint256 lender;
            uint256 dataLen;
            bytes memory lenderData;
            address asset;
            uint256 amount;
            address receiver;

            assembly {
                let ed := add(add(executionData, 0x20), newExecOffset)

                asset := shr(96, mload(ed))
                amount := shr(144, mload(add(ed, 20)))
                receiver := shr(96, mload(add(ed, 34)))

                let actionStart := add(ed, 54)
                op := shr(248, mload(actionStart))
                lender := and(0xffff, shr(240, mload(add(actionStart, 1))))
                dataLen := and(0xffff, shr(240, mload(add(actionStart, 3))))

                let fmp := mload(0x40)
                mstore(fmp, dataLen)
                let src := add(actionStart, 5)
                let dest := add(fmp, 0x20)
                for { let j := 0 } lt(j, dataLen) { j := add(j, 32) } {
                    mstore(add(dest, j), mload(add(src, j)))
                }
                lenderData := fmp
                mstore(0x40, add(dest, and(add(dataLen, 31), not(31))))

                let leafLen := add(3, dataLen)
                let scratch := mload(0x40)
                mstore8(scratch, op)
                mstore8(add(scratch, 1), shr(8, lender))
                mstore8(add(scratch, 2), and(0xff, lender))
                for { let j := 0 } lt(j, dataLen) { j := add(j, 32) } {
                    mstore(add(add(scratch, 3), j), mload(add(src, j)))
                }
                let leaf := keccak256(scratch, leafLen)

                let proofStart := add(actionStart, add(5, dataLen))
                let proofLen := shr(248, mload(proofStart))
                let proofPtr := add(proofStart, 1)

                for { let p := 0 } lt(p, proofLen) { p := add(p, 1) } {
                    let sibling := mload(proofPtr)
                    switch lt(leaf, sibling)
                    case 1 {
                        mstore(0x00, leaf)
                        mstore(0x20, sibling)
                    }
                    default {
                        mstore(0x00, sibling)
                        mstore(0x20, leaf)
                    }
                    leaf := keccak256(0x00, 0x40)
                    proofPtr := add(proofPtr, 32)
                }

                if xor(leaf, merkleRoot) {
                    mstore(0x00, 0xb05e92fa00000000000000000000000000000000000000000000000000000000)
                    revert(0x00, 0x04)
                }

                newExecOffset := add(
                    newExecOffset,
                    add(add(60, dataLen), mul(proofLen, 32))
                )
            }

            // Track lender bucket for post-settlement health checks.
            // Using the original conditional form to avoid stack-too-deep.
            if (op == OP_BORROW || op == OP_WITHDRAW || op == OP_WITHDRAW_LENDING_TOKEN) {
                uint256 bucket;
                if (lender < 2000) bucket = 0;
                else if (lender < 3000) bucket = 1;
                else if (lender < 4000) bucket = 2;
                else bucket = 3;
                riskyLenderMask |= (1 << bucket);
            }

            newDeltaCount = _dispatchAndAccumulate(
                orderSigner, asset, amount, receiver, op, lender, lenderData, deltas, newDeltaCount
            );

            unchecked { ++i; }
        }
    }

    // ── Internal helpers ────────────────────────────────────

    /**
     * @notice Dispatch one lending operation, fold into deltas, track borrows.
     */
    function _dispatchAndAccumulate(
        address orderSigner,
        address asset,
        uint256 amount,
        address receiver,
        uint256 op,
        uint256 lender,
        bytes memory lenderData,
        AssetDelta[] memory deltas,
        uint256 deltaCount
    ) private returns (uint256 newDeltaCount) {
        // Receiver override for deposit/repay: force orderSigner so position
        // credits (aTokens, debt reduction) go to the user who signed the order.
        // Borrow/withdraw keep the solver-specified receiver (typically address(this))
        // — delta accounting + non-borrow surplus revert prevent theft.
        address effectiveReceiver = (op == OP_BORROW || op == OP_WITHDRAW || op == OP_WITHDRAW_LENDING_TOKEN)
            ? receiver
            : orderSigner;
        (address assetUsed, uint256 amountIn, uint256 amountOut) =
            _lendingOperations(orderSigner, asset, amount, effectiveReceiver, op, lender, lenderData);

        int256 change = int256(amountOut) - int256(amountIn);

        // For BORROW ops, track the gross borrowed amount for fee % calculation
        uint256 borrowAmount = (op == OP_BORROW) ? amountOut : 0;

        if (change != 0 || borrowAmount != 0) {
            newDeltaCount = _updateDelta(deltas, deltaCount, assetUsed, change, borrowAmount);
        } else {
            newDeltaCount = deltaCount;
        }
    }

    /**
     * @notice Sweep borrow-surplus as fee and verify no deficits or unaccounted surplus.
     *
     * @dev For each tracked asset:
     *
     *        delta > 0, totalBorrowed > 0 → borrow surplus = solver fee
     *            Percentage-checked: surplus × 1e7 ≤ totalBorrowed × maxFeeBps
     *            Transferred to feeRecipient.
     *
     *        delta > 0, totalBorrowed == 0 → non-borrow surplus → revert
     *            The solver MUST deposit excess back into a lender for the user
     *            via post-actions. Any remaining surplus is an error.
     *
     *        delta < 0 → deficit → revert (UnbalancedSettlement)
     *        delta == 0 → balanced → ok
     */
    function _sweepAndVerify(
        AssetDelta[] memory deltas,
        uint256 count,
        address,
        address feeRecipient,
        uint256 maxFeeBps
    ) private {
        for (uint256 i; i < count;) {
            int256 d = deltas[i].delta;

            if (d < 0) {
                revert UnbalancedSettlement();
            }

            if (d > 0) {
                uint256 surplus = uint256(d);
                uint256 borrowed = deltas[i].totalBorrowed;

                if (borrowed > 0) {
                    // Borrow surplus → solver fee (percentage-checked)
                    if (surplus * FEE_DENOMINATOR > borrowed * maxFeeBps) {
                        revert FeeExceedsMax();
                    }
                    if (feeRecipient != address(0)) {
                        _transferOut(deltas[i].asset, surplus, feeRecipient);
                    }
                } else {
                    // Non-borrow surplus → revert. Solver must re-deposit excess
                    // into a lender for the user via post-actions.
                    revert UnbalancedSettlement();
                }
            }

            unchecked { ++i; }
        }
    }

    /**
     * @notice Transfer tokens out — used for solver fees.
     */
    function _transferOut(address asset, uint256 amount, address recipient) private {
        assembly {
            mstore(0x00, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(0x04, recipient)
            mstore(0x24, amount)

            let success := call(gas(), asset, 0, 0x00, 0x44, 0x00, 0x20)
            let rdsize := returndatasize()
            success := and(
                success,
                or(iszero(rdsize), and(gt(rdsize, 31), eq(mload(0x00), 1)))
            )
            if iszero(success) {
                returndatacopy(0, 0, rdsize)
                revert(0, rdsize)
            }
        }
    }

    /**
     * @notice Upsert a per-asset delta entry with borrow tracking.
     * @param deltas       Pre-allocated array.
     * @param count        Current number of occupied entries.
     * @param asset        Token address to update.
     * @param change       Signed delta change (+amountOut − amountIn).
     * @param borrowAmount Gross borrow amount to add (0 for non-borrow ops).
     */
    function _updateDelta(
        AssetDelta[] memory deltas,
        uint256 count,
        address asset,
        int256 change,
        uint256 borrowAmount
    ) internal pure returns (uint256 newCount) {
        for (uint256 i; i < count;) {
            if (deltas[i].asset == asset) {
                deltas[i].delta += change;
                deltas[i].totalBorrowed += borrowAmount;
                return count;
            }
            unchecked { ++i; }
        }
        deltas[count] = AssetDelta(asset, change, borrowAmount);
        return count + 1;
    }

    // ── Virtual hooks ───────────────────────────────────────

    /**
     * @notice Intent hook — called between pre-actions and post-actions.
     * @dev Concrete implementations use this to execute asset conversions.
     *      The `deltas` array MUST be updated in-place to reflect any conversion.
     *      If no conversion is needed, return `deltaCount` unchanged.
     *
     * @param orderSigner  The order signer / position owner.
     * @param settlementData The user-signed settlement parameters (extracted from orderData).
     *                       Empty bytes if no intent parameters were signed.
     * @param fillerCalldata Solver-provided swap execution payload.
     *                       Empty bytes if no conversion needed (no-op).
     * @param deltas         Per-asset delta array (modified in-place).
     * @param deltaCount     Current number of unique assets tracked.
     * @return newDeltaCount Updated count after any new assets introduced by conversions.
     */
    function _executeIntent(
        address orderSigner,
        bytes memory settlementData,
        bytes memory fillerCalldata,
        AssetDelta[] memory deltas,
        uint256 deltaCount
    ) internal virtual returns (uint256 newDeltaCount);

    /**
     * @notice Post-settlement condition hook — called after fee sweep and zero-sum
     *         verification, when the user's position is in its final state.
     * @dev Override to enforce conditions such as minimum health factor.
     *      Default implementation is a no-op.
     *
     * @param orderSigner  The order signer / position owner.
     * @param settlementData The user-signed settlement parameters (extracted from orderData).
     */
    /**
     * @notice Post-settlement health factor checks. Only called for lender
     *         buckets that had a borrow or withdraw (bitmap in riskyLenderMask).
     * @param riskyLenderMask Bitmap of lender buckets with risky ops:
     *        bit 0 = Aave (<2000), bit 1 = CompV3 (<3000), bit 2 = CompV2 (<4000),
     *        bit 3 = Morpho (<5000)
     */
    function _postSettlementCheck(
        address orderSigner,
        bytes memory settlementData,
        uint256 riskyLenderMask
    ) internal virtual {}
}
