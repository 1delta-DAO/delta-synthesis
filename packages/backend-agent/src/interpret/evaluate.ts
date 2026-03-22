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
  destLender: string
  collateralToken: Address
  collateralSymbol: string
  debtToken: Address
  debtSymbol: string
  collateralAmountUsd: number
  debtAmountUsd: number
  /** Net yield = (depositAPR * deposits - borrowAPR * borrows) / NAV */
  sourceNetYield: number
  destNetYield: number
  /** Positive = destination is better */
  improvement: number
  /** Leaf indices for the 4 actions */
  withdrawLeafIndex: number | undefined
  depositLeafIndex: number | undefined
  repayLeafIndex: number | undefined
  borrowLeafIndex: number | undefined
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

interface PermittedOp {
  leafIndex: number
  lenderKey: string
  lenderId: number
}

function extractPermittedOps(leaves: LeafDescription[]) {
  const withdraws: PermittedWithdraw[] = []
  const deposits: PermittedDeposit[] = []
  const borrows: PermittedOp[] = []
  const repays: PermittedOp[] = []

  for (const leaf of leaves) {
    const key = lenderIdToKey(leaf.lenderId)
    if (leaf.op === 'WITHDRAW') {
      withdraws.push({ leafIndex: leaf.index, lenderKey: key, lenderId: leaf.lenderId })
    }
    if (leaf.op === 'DEPOSIT') {
      deposits.push({ leafIndex: leaf.index, lenderKey: key, lenderId: leaf.lenderId })
    }
    if (leaf.op === 'BORROW') {
      borrows.push({ leafIndex: leaf.index, lenderKey: key, lenderId: leaf.lenderId })
    }
    if (leaf.op === 'REPAY') {
      repays.push({ leafIndex: leaf.index, lenderKey: key, lenderId: leaf.lenderId })
    }
  }

  return { withdraws, deposits, borrows, repays }
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

  // Debt path: evaluate full position migrations (flash loan required)
  const debtCandidates = evaluateDebtMigrations(userSummary, pools, leaves)
  return {
    hasDebt: true,
    candidates: debtCandidates,
    bestCandidate: debtCandidates[0] ?? null,
  }
}

// ── Debt position migration evaluation ──────────────────────────────────

/**
 * Compute net yield: (depositAPR * depositsUsd - borrowAPR * borrowsUsd) / NAV
 * Returns annualized % (e.g. 2.5 = 2.5% net yield)
 */
function computeNetYield(
  depositRate: number, depositsUsd: number,
  borrowRate: number, borrowsUsd: number,
): number {
  const nav = depositsUsd - borrowsUsd
  if (nav <= 0) return -Infinity
  return (depositRate * depositsUsd - borrowRate * borrowsUsd) / nav
}

function evaluateDebtMigrations(
  userSummary: UserSummary,
  pools: PoolInfo[],
  leaves: LeafDescription[],
): DebtMigration[] {
  const { withdraws, deposits, borrows, repays } = extractPermittedOps(leaves)
  const candidates: DebtMigration[] = []

  for (const lender of userSummary.lenders) {
    if (!lender.hasDebt) continue
    if (lender.deposits.length === 0 || lender.debts.length === 0) continue

    // Check user has permitted WITHDRAW + REPAY from this lender
    const permittedWithdraw = withdraws.find(w => {
      const lenderUpper = lender.protocol.toUpperCase()
      if (lenderUpper === 'MOOLA') return w.lenderKey === 'AAVE_V2'
      return w.lenderKey === lenderUpper || lenderUpper.startsWith(w.lenderKey)
    })
    const permittedRepay = repays.find(r => {
      const lenderUpper = lender.protocol.toUpperCase()
      if (lenderUpper === 'MOOLA') return r.lenderKey === 'AAVE_V2'
      return r.lenderKey === lenderUpper || lenderUpper.startsWith(r.lenderKey)
    })
    if (!permittedWithdraw || !permittedRepay) continue

    // Get source rates for the collateral and debt tokens
    const collateral = lender.deposits[0] // primary collateral
    const debt = lender.debts[0] // primary debt

    const sourceCollateralPool = pools.find(
      p => p.lenderKey === lender.protocol &&
           p.token.toLowerCase() === collateral.token.toLowerCase(),
    )
    const sourceDebtPool = pools.find(
      p => p.lenderKey === lender.protocol &&
           p.token.toLowerCase() === debt.token.toLowerCase(),
    )

    const sourceDepositRate = sourceCollateralPool?.depositRate ?? 0
    const sourceBorrowRate = sourceDebtPool?.variableBorrowRate ?? 0
    const sourceNetYield = computeNetYield(
      sourceDepositRate, lender.totalDepositsUsd,
      sourceBorrowRate, lender.totalDebtUsd,
    )

    // Find destination lenders with permitted DEPOSIT + BORROW
    for (const permittedDeposit of deposits) {
      if (permittedDeposit.lenderKey === permittedWithdraw.lenderKey) continue

      const permittedBorrow = borrows.find(b => b.lenderKey === permittedDeposit.lenderKey)
      if (!permittedBorrow) continue

      // Check destination has pools for both collateral and debt tokens
      const destCollateralPool = pools.find(
        p => leafMatchesLender({ lenderId: permittedDeposit.lenderId } as LeafDescription, p.lenderKey) &&
             p.token.toLowerCase() === collateral.token.toLowerCase() &&
             p.collateralActive,
      )
      const destDebtPool = pools.find(
        p => leafMatchesLender({ lenderId: permittedBorrow.lenderId } as LeafDescription, p.lenderKey) &&
             p.token.toLowerCase() === debt.token.toLowerCase() &&
             p.borrowingEnabled,
      )
      if (!destCollateralPool || !destDebtPool) continue
      // Need enough borrow liquidity
      if (destDebtPool.totalLiquidityUsd < lender.totalDebtUsd * 0.5) continue

      const destNetYield = computeNetYield(
        destCollateralPool.depositRate, lender.totalDepositsUsd,
        destDebtPool.variableBorrowRate, lender.totalDebtUsd,
      )

      const improvement = destNetYield - sourceNetYield

      candidates.push({
        type: 'debt_migration',
        sourceLender: lender.protocol,
        destLender: destCollateralPool.lenderKey,
        collateralToken: collateral.token,
        collateralSymbol: collateral.symbol,
        debtToken: debt.token,
        debtSymbol: debt.symbol,
        collateralAmountUsd: lender.totalDepositsUsd,
        debtAmountUsd: lender.totalDebtUsd,
        sourceNetYield,
        destNetYield,
        improvement,
        withdrawLeafIndex: permittedWithdraw.leafIndex,
        depositLeafIndex: permittedDeposit.leafIndex,
        repayLeafIndex: permittedRepay.leafIndex,
        borrowLeafIndex: permittedBorrow.leafIndex,
        needsFlashLoan: true,
      })
    }
  }

  return candidates.sort((a, b) => b.improvement - a.improvement)
}
