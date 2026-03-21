/**
 * Settlement evaluator — branches strategy based on user's position type.
 *
 * 1) User has debt → full migration flow (flash loan + repay + withdraw + deposit + borrow)
 * 2) User has no debt → simple collateral migration (withdraw + deposit, no flash loan needed)
 *
 * For collateral-only migrations:
 *   - Read the user's Merkle leaves to find which WITHDRAW and DEPOSIT operations are permitted
 *   - For each permitted WITHDRAW, find the user's current deposit and its rate
 *   - For each permitted DEPOSIT, look up the pool's deposit rate
 *   - Match by token: find cases where the user can withdraw token X from lender A
 *     and deposit token X into lender B at a higher rate
 *   - Rank by APY improvement
 */

import type { Address } from 'viem'
import type { UserSummary } from './positions.js'
import type { PoolInfo } from './pools.js'
import type { LeafDescription } from '../order.js'
import { LenderRange } from '@delta-synthesis/settlement-sdk'

// ── Types ───────────────────────────────────────────────────────────────

export interface CollateralMigration {
  type: 'collateral_only'
  /** Source lender the user currently deposits in */
  sourceLender: string
  /** Destination lender */
  destLender: string
  /** Token being moved */
  token: Address
  symbol: string
  amountUsd: number
  /** Current deposit APY at source */
  sourceDepositRate: number
  /** Destination deposit APY */
  destDepositRate: number
  /** Rate improvement (dest - source) */
  improvement: number
  /** Leaf index for WITHDRAW from source */
  withdrawLeafIndex: number | undefined
  /** Leaf index for DEPOSIT to destination */
  depositLeafIndex: number | undefined
  /** No flash loan needed */
  needsFlashLoan: false
}

export interface DebtMigration {
  type: 'debt_migration'
  sourceLender: string
  collateralToken: Address
  debtToken: Address
  debtAmountUsd: number
  sourceNetYield: number | null
  destLender: string
  destNetYield: number | null
  improvement: number | null
  needsFlashLoan: true
}

export interface CollateralSwapMigration {
  type: 'collateral_swap'
  /** Source lender to withdraw from */
  sourceLender: string
  /** Destination lender to deposit into */
  destLender: string
  /** Token being withdrawn */
  sourceToken: Address
  sourceSymbol: string
  /** Token being deposited (different from source — requires swap) */
  destToken: Address
  destSymbol: string
  amountUsd: number
  /** Source deposit APY for sourceToken */
  sourceDepositRate: number
  /** Destination deposit APY for destToken */
  destDepositRate: number
  /** Rate improvement */
  improvement: number
  /** Leaf indices */
  withdrawLeafIndex: number | undefined
  depositLeafIndex: number | undefined
  /** Needs a swap but NOT a flash loan (no debt involved) */
  needsFlashLoan: false
  needsSwap: true
}

export type MigrationCandidate = CollateralMigration | CollateralSwapMigration | DebtMigration

export interface EvaluationResult {
  hasDebt: boolean
  candidates: MigrationCandidate[]
  bestCandidate: MigrationCandidate | null
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Map a lenderKey to the numeric ID range for leaf matching */
function lenderKeyToRange(key: string): { min: number; max: number } | null {
  const upper = key.toUpperCase()
  if (upper === 'AAVE_V3' || upper.startsWith('AAVE_V3_')) return LenderRange.AAVE_V3
  if (upper === 'MOOLA' || upper === 'AAVE_V2' || upper.startsWith('AAVE_V2_')) return LenderRange.AAVE_V2
  if (upper.startsWith('MORPHO_BLUE')) return LenderRange.MORPHO_BLUE
  if (upper.startsWith('COMPOUND_V3')) return LenderRange.COMPOUND_V3
  if (upper.startsWith('COMPOUND_V2')) return LenderRange.COMPOUND_V2
  return null
}

function leafMatchesLender(leaf: LeafDescription, lenderKey: string): boolean {
  const range = lenderKeyToRange(lenderKey)
  if (!range) return false
  return leaf.lenderId >= range.min && leaf.lenderId <= range.max
}

// ── Permitted operations from leaves ────────────────────────────────────

interface PermittedWithdraw {
  leafIndex: number
  lenderKey: string
  lenderId: number
}

interface PermittedDeposit {
  leafIndex: number
  lenderKey: string
  lenderId: number
}

/** Resolve numeric lenderId back to a lender key string */
function lenderIdToKey(id: number): string {
  if (id >= LenderRange.MORPHO_BLUE.min && id <= LenderRange.MORPHO_BLUE.max) return 'MORPHO_BLUE'
  if (id >= LenderRange.COMPOUND_V2.min && id <= LenderRange.COMPOUND_V2.max) return 'COMPOUND_V2'
  if (id >= LenderRange.COMPOUND_V3.min && id <= LenderRange.COMPOUND_V3.max) return 'COMPOUND_V3'
  if (id >= LenderRange.AAVE_V2.min && id <= LenderRange.AAVE_V2.max) return 'AAVE_V2'
  if (id >= LenderRange.AAVE_V3.min && id <= LenderRange.AAVE_V3.max) return 'AAVE_V3'
  return `UNKNOWN_${id}`
}

function extractPermittedOps(leaves: LeafDescription[]) {
  const withdraws: PermittedWithdraw[] = []
  const deposits: PermittedDeposit[] = []

  for (const leaf of leaves) {
    const key = lenderIdToKey(leaf.lenderId)
    if (leaf.op === 'WITHDRAW') {
      withdraws.push({ leafIndex: leaf.index, lenderKey: key, lenderId: leaf.lenderId })
    }
    if (leaf.op === 'DEPOSIT') {
      deposits.push({ leafIndex: leaf.index, lenderKey: key, lenderId: leaf.lenderId })
    }
  }

  return { withdraws, deposits }
}

// ── Collateral-only evaluation (no debt) ────────────────────────────────

function evaluateCollateralMigrations(
  userSummary: UserSummary,
  pools: PoolInfo[],
  leaves: LeafDescription[],
): CollateralMigration[] {
  const { withdraws, deposits } = extractPermittedOps(leaves)
  const candidates: CollateralMigration[] = []

  // For each lender the user has deposits in (without debt)
  for (const lender of userSummary.lenders) {
    if (lender.hasDebt) continue

    // Check if the user has a permitted WITHDRAW from this lender
    const permittedWithdraw = withdraws.find(w => {
      // Match by lender key prefix (e.g. "AAVE_V3" matches "AAVE_V3")
      // For Moola, it uses AAVE_V2 range
      const lenderUpper = lender.protocol.toUpperCase()
      if (lenderUpper === 'MOOLA') return w.lenderKey === 'AAVE_V2'
      return w.lenderKey === lenderUpper || lenderUpper.startsWith(w.lenderKey)
    })

    if (!permittedWithdraw) continue

    // For each deposited token
    for (const deposit of lender.deposits) {
      // Find the source pool rate
      const sourcePool = pools.find(
        p => p.lenderKey === lender.protocol &&
             p.token.toLowerCase() === deposit.token.toLowerCase(),
      )
      const sourceRate = sourcePool?.depositRate ?? 0

      // Find all permitted DEPOSIT destinations for the same token
      for (const permittedDeposit of deposits) {
        // Skip if same lender
        if (permittedDeposit.lenderKey === permittedWithdraw.lenderKey) continue

        // Find the destination pool for this token + lender
        const destPool = pools.find(
          p => p.token.toLowerCase() === deposit.token.toLowerCase() &&
               leafMatchesLender({ lenderId: permittedDeposit.lenderId } as LeafDescription, p.lenderKey) &&
               p.collateralActive,
        )

        if (!destPool) continue
        if (destPool.depositRate <= sourceRate) continue
        // Require some liquidity headroom
        if (destPool.totalLiquidityUsd < deposit.amountUsd * 0.1) continue

        candidates.push({
          type: 'collateral_only',
          sourceLender: lender.protocol,
          destLender: destPool.lenderKey,
          token: deposit.token,
          symbol: deposit.symbol,
          amountUsd: deposit.amountUsd,
          sourceDepositRate: sourceRate,
          destDepositRate: destPool.depositRate,
          improvement: destPool.depositRate - sourceRate,
          withdrawLeafIndex: permittedWithdraw.leafIndex,
          depositLeafIndex: permittedDeposit.leafIndex,
          needsFlashLoan: false,
        })
      }
    }
  }

  return candidates.sort((a, b) => b.improvement - a.improvement)
}

// ── Cross-asset collateral swap evaluation ──────────────────────────────

function evaluateCollateralSwapMigrations(
  userSummary: UserSummary,
  pools: PoolInfo[],
  leaves: LeafDescription[],
): CollateralSwapMigration[] {
  const { withdraws, deposits } = extractPermittedOps(leaves)
  const candidates: CollateralSwapMigration[] = []

  for (const lender of userSummary.lenders) {
    if (lender.hasDebt) continue

    const permittedWithdraw = withdraws.find(w => {
      const lenderUpper = lender.protocol.toUpperCase()
      if (lenderUpper === 'MOOLA') return w.lenderKey === 'AAVE_V2'
      return w.lenderKey === lenderUpper || lenderUpper.startsWith(w.lenderKey)
    })
    if (!permittedWithdraw) continue

    for (const deposit of lender.deposits) {
      const sourcePool = pools.find(
        p => p.lenderKey === lender.protocol &&
             p.token.toLowerCase() === deposit.token.toLowerCase(),
      )
      const sourceRate = sourcePool?.depositRate ?? 0

      // Look for deposits into DIFFERENT tokens at any permitted destination
      for (const permittedDeposit of deposits) {
        // Find all pools at this destination lender with different tokens
        const destPools = pools.filter(
          p => leafMatchesLender({ lenderId: permittedDeposit.lenderId } as LeafDescription, p.lenderKey) &&
               p.token.toLowerCase() !== deposit.token.toLowerCase() &&
               p.collateralActive &&
               p.depositRate > sourceRate,
        )

        for (const destPool of destPools) {
          if (destPool.totalLiquidityUsd < deposit.amountUsd * 0.1) continue

          candidates.push({
            type: 'collateral_swap',
            sourceLender: lender.protocol,
            destLender: destPool.lenderKey,
            sourceToken: deposit.token,
            sourceSymbol: deposit.symbol,
            destToken: destPool.token,
            destSymbol: destPool.symbol,
            amountUsd: deposit.amountUsd,
            sourceDepositRate: sourceRate,
            destDepositRate: destPool.depositRate,
            improvement: destPool.depositRate - sourceRate,
            withdrawLeafIndex: permittedWithdraw.leafIndex,
            depositLeafIndex: permittedDeposit.leafIndex,
            needsFlashLoan: false,
            needsSwap: true,
          })
        }
      }
    }
  }

  return candidates.sort((a, b) => b.improvement - a.improvement)
}

// ── Full evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate migration candidates based on user positions, available pools,
 * and the permitted operations in the order's Merkle leaves.
 */
export function evaluateMigrations(
  userSummary: UserSummary,
  pools: PoolInfo[],
  leaves: LeafDescription[],
): EvaluationResult {
  if (!userSummary.hasAnyDebt) {
    // Same-token migrations + cross-asset swap migrations, ranked together
    const sameToken = evaluateCollateralMigrations(userSummary, pools, leaves)
    const crossAsset = evaluateCollateralSwapMigrations(userSummary, pools, leaves)
    const candidates: MigrationCandidate[] = [...sameToken, ...crossAsset]
      .sort((a, b) => b.improvement - a.improvement)
    return {
      hasDebt: false,
      candidates,
      bestCandidate: candidates[0] ?? null,
    }
  }

  // Debt path: handled by the existing context.ts flow
  // Return empty here — caller should fall through to runSettlementFlow
  return {
    hasDebt: true,
    candidates: [],
    bestCandidate: null,
  }
}
