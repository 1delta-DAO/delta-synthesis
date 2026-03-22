/**
 * Builds executionData and fillerCalldata for settlement transactions.
 *
 * The user signs an order with a Merkle root + settlementData, but executionData
 * and fillerCalldata are built by the solver/agent at fill time.
 *
 * For a same-token collateral migration (no swap, no debt):
 *   executionData = [1 pre-action (WITHDRAW), 1 post-action (DEPOSIT)]
 *   fillerCalldata = 0x (no swap)
 *
 * For a cross-asset swap migration (no debt):
 *   executionData = [1 pre-action (WITHDRAW), 1 post-action (DEPOSIT)]
 *   fillerCalldata = [swap via Uniswap]
 */

import type { Address, Hex } from 'viem'
import { zeroAddress } from 'viem'
import {
  encodeExecutionData,
  encodeFillerCalldata,
  AMOUNT_BALANCE,
  AMOUNT_MAX,
  type MerkleAction,
  type FillerSwap,
} from '@delta-synthesis/settlement-sdk'
import type { MerkleLeaf, StoredOrder } from '../order.js'
import type { CollateralMigration, CollateralSwapMigration } from './evaluate.js'

// ── Types ───────────────────────────────────────────────────────────────

export interface BuiltSettlement {
  executionData: Hex
  fillerCalldata: Hex
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a MerkleAction from a stored leaf.
 *
 * @param leaf      The Merkle leaf from the order
 * @param asset     The token address being acted on
 * @param amount    Amount sentinel: AMOUNT_MAX for full withdraw, AMOUNT_BALANCE for "use balance"
 * @param receiver  Where the tokens go: verato contract (pre-actions) or user (post-actions)
 */
function buildAction(
  leaf: MerkleLeaf,
  asset: Address,
  amount: bigint,
  receiver: Address,
): MerkleAction {
  return {
    asset,
    amount,
    receiver,
    op: leaf.op as 0 | 1 | 2 | 3 | 4 | 5,
    lenderId: leaf.lenderId,
    data: leaf.data,
    proof: leaf.proof,
  }
}

// ── Same-token collateral migration ─────────────────────────────────────

/**
 * Build executionData for a same-token collateral migration.
 *
 * Flow: WITHDRAW from source (pre-action) → DEPOSIT to dest (post-action)
 * No swap, no flash loan.
 *
 * Matches the test pattern:
 *   executionData = [numPre=1][numPost=1][feeRecipient=0x0]
 *     pre:  [asset][AMOUNT_MAX][verato][WITHDRAW][lenderId][data][proof]
 *     post: [asset][AMOUNT_BALANCE][user][DEPOSIT][lenderId][data][proof]
 */
export function buildCollateralMigration(
  order: StoredOrder,
  migration: CollateralMigration,
  veratoAddress: Address,
  feeRecipient?: Address,
): BuiltSettlement {
  const withdrawLeaf = order.order.leaves[migration.withdrawLeafIndex!]
  const depositLeaf = order.order.leaves[migration.depositLeafIndex!]

  if (!withdrawLeaf || !depositLeaf) {
    throw new Error(`Missing leaves: withdraw=${migration.withdrawLeafIndex} deposit=${migration.depositLeafIndex}`)
  }

  const preActions: MerkleAction[] = [
    buildAction(
      withdrawLeaf,
      migration.token,
      AMOUNT_MAX,         // withdraw full position
      veratoAddress,       // tokens go to Verato first
    ),
  ]

  const postActions: MerkleAction[] = [
    buildAction(
      depositLeaf,
      migration.token,
      AMOUNT_BALANCE,      // deposit whatever Verato is holding (= withdrawn amount)
      order.signer,        // deposit on behalf of user
    ),
  ]

  const executionData = encodeExecutionData(
    preActions,
    postActions,
    feeRecipient ?? zeroAddress,
  )

  return {
    executionData,
    fillerCalldata: '0x' as Hex,  // no swap
  }
}

// ── Cross-asset swap migration ──────────────────────────────────────────

/**
 * Build executionData + fillerCalldata for a cross-asset collateral swap.
 *
 * Flow: WITHDRAW sourceToken (pre) → SWAP sourceToken→destToken → DEPOSIT destToken (post)
 *
 * The fillerCalldata contains the Uniswap swap execution.
 * The caller must provide a FillerSwap (from buildFillerSwap() in the SDK).
 */
export function buildCollateralSwapMigration(
  order: StoredOrder,
  migration: CollateralSwapMigration,
  swap: FillerSwap,
  veratoAddress: Address,
  feeRecipient?: Address,
): BuiltSettlement {
  const withdrawLeaf = order.order.leaves[migration.withdrawLeafIndex!]
  const depositLeaf = order.order.leaves[migration.depositLeafIndex!]

  if (!withdrawLeaf || !depositLeaf) {
    throw new Error(`Missing leaves: withdraw=${migration.withdrawLeafIndex} deposit=${migration.depositLeafIndex}`)
  }

  const preActions: MerkleAction[] = [
    buildAction(
      withdrawLeaf,
      migration.sourceToken,
      AMOUNT_MAX,
      veratoAddress,
    ),
  ]

  const postActions: MerkleAction[] = [
    buildAction(
      depositLeaf,
      migration.destToken,
      AMOUNT_BALANCE,       // deposit all received tokens after swap
      order.signer,
    ),
  ]

  const executionData = encodeExecutionData(
    preActions,
    postActions,
    feeRecipient ?? zeroAddress,
  )

  // The contract reads numSwaps from the first byte of fillerCalldata
  // and matches each filler swap to a signed conversion by asset pair.
  // Only include the swap we're actually executing.
  const fillerCalldata = encodeFillerCalldata([swap])

  return {
    executionData,
    fillerCalldata,
  }
}
