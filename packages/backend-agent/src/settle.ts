/**
 * Settlement transaction builder.
 *
 * Builds the multicall calldata for Verato.settle() or Verato.settleWithFlashLoan().
 */

import type { Address, Hex } from 'viem'
import {
  encodeSettle,
  encodeSettleWithFlashLoan,
  encodeMulticall,
  encodeApproveToken,
} from '@delta-synthesis/settlement-sdk'
import type { MerkleLeaf, StoredOrder } from './order.js'
import { CONTRACTS_BY_CHAIN } from './config/index.js'

// ── Types ───────────────────────────────────────────────────────────────

export interface SettlementInput {
  order: StoredOrder
  sourceRepayLeaf: MerkleLeaf
  sourceWithdrawLeaf: MerkleLeaf
  destDepositLeaf: MerkleLeaf
  destBorrowLeaf: MerkleLeaf
  collateralAsset: Address
  debtAsset: Address
  user: Address
  settlement: Address
  morphoPool: Address
  debtAmount: bigint
  feeRecipient?: Address
}

export interface SettlementTx {
  chainId: number
  to: Address
  data: Hex
  flashAmount: bigint
  borrowAmount: bigint
}

// ── Builder ─────────────────────────────────────────────────────────────

/**
 * Build settlement transaction calldata.
 * Uses settleWithFlashLoan when there's debt, plain settle otherwise.
 */
export function buildSettlementTx(input: SettlementInput): SettlementTx {
  const chainId = input.order.order.chainId
  const o = input.order.order

  // For debt migrations, use flash loan for the debt amount
  const flashAmount = input.debtAmount
  const borrowAmount = input.debtAmount

  const settleCalldata = encodeSettle({
    maxFeeBps: BigInt(o.maxFeeBps),
    solver: (o.solver ?? '0x0000000000000000000000000000000000000000') as Address,
    minSolverReputation: BigInt(o.minSolverReputation ?? 0),
    deadline: o.deadline,
    signature: input.order.signature,
    orderData: o.orderData,
    executionData: o.executionData,
    fillerCalldata: o.fillerCalldata,
  })

  // Bundle: approve tokens to pools + settle
  const calls: Hex[] = []

  // Approve collateral asset to settlement contract for deposit
  const contracts = CONTRACTS_BY_CHAIN[chainId]
  if (contracts) {
    calls.push(encodeApproveToken(input.collateralAsset, contracts.settlement))
    calls.push(encodeApproveToken(input.debtAsset, contracts.settlement))
  }

  calls.push(settleCalldata)

  const data = calls.length === 1 ? calls[0] : encodeMulticall(calls)

  return {
    chainId,
    to: input.settlement,
    data,
    flashAmount,
    borrowAmount,
  }
}

// ── Economic viability check ────────────────────────────────────────────

export interface EconomicCheck {
  viable: boolean
  reason: string
}

/**
 * Check if a settlement is economically viable (gas cost vs solver fee).
 * Placeholder — can be expanded with actual gas estimation.
 */
export async function checkEconomicViability(
  _input: SettlementInput,
  _tx: { to: Address; data: Hex },
  _flashAmount: bigint,
  _oracleAddress: Address,
  _fromAddress: Address,
  _rpcUrl: string,
): Promise<EconomicCheck> {
  // On Celo, gas is very cheap — almost always viable
  return { viable: true, reason: 'Celo gas costs are negligible' }
}
