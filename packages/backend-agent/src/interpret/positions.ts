/**
 * Position interpreter — pre-digests raw API positions into clean typed structures
 * that lightweight LLMs can reason about without parsing nested blobs.
 */

import type { Address } from 'viem'
import type { LenderPositions, AccountData, PositionEntry } from '../direct/api.js'

// ── Clean output types ──────────────────────────────────────────────────

export interface TokenBalance {
  token: Address
  symbol: string
  decimals: number
  amountUsd: number
  logoURI?: string
}

export interface LenderSummary {
  protocol: string
  healthFactor: number
  totalDepositsUsd: number
  totalDebtUsd: number
  nav: number
  deposits: TokenBalance[]
  debts: TokenBalance[]
  hasDebt: boolean
}

export interface UserSummary {
  account: string
  chainId: string
  lenders: LenderSummary[]
  /** True if any lender has active debt */
  hasAnyDebt: boolean
  /** Total deposits across all lenders */
  totalDepositsUsd: number
  /** Total debt across all lenders */
  totalDebtUsd: number
}

// ── Interpreter ─────────────────────────────────────────────────────────

function extractBalances(positions: PositionEntry[], type: 'deposits' | 'debt'): TokenBalance[] {
  const results: TokenBalance[] = []
  for (const pos of positions) {
    const amount = type === 'deposits' ? pos.depositsUSD : pos.debtUSD
    if (amount <= 0) continue
    const asset = pos.underlyingInfo?.asset
    if (!asset) continue
    results.push({
      token: asset.address as Address,
      symbol: asset.symbol,
      decimals: asset.decimals,
      amountUsd: amount,
      logoURI: asset.logoURI,
    })
  }
  return results.sort((a, b) => b.amountUsd - a.amountUsd)
}

function summarizeLender(lp: LenderPositions): LenderSummary | null {
  if (lp.data.length === 0) return null

  const acct = lp.data[0]
  const activePositions = acct.positions.filter(
    p => parseFloat(p.deposits) > 0 || parseFloat(p.debt) > 0,
  )
  if (activePositions.length === 0) return null

  const deposits = extractBalances(activePositions, 'deposits')
  const debts = extractBalances(activePositions, 'debt')

  return {
    protocol: lp.lender,
    healthFactor: acct.health ?? Infinity,
    totalDepositsUsd: acct.balanceData.deposits,
    totalDebtUsd: acct.balanceData.debt,
    nav: acct.balanceData.nav,
    deposits,
    debts,
    hasDebt: acct.balanceData.debt > 0,
  }
}

/**
 * Interpret raw LenderPositions[] into a clean UserSummary.
 */
export function interpretPositions(
  account: string,
  chainId: string,
  raw: LenderPositions[],
): UserSummary {
  const lenders: LenderSummary[] = []

  for (const lp of raw) {
    const summary = summarizeLender(lp)
    if (summary) lenders.push(summary)
  }

  return {
    account,
    chainId,
    lenders,
    hasAnyDebt: lenders.some(l => l.hasDebt),
    totalDepositsUsd: lenders.reduce((s, l) => s + l.totalDepositsUsd, 0),
    totalDebtUsd: lenders.reduce((s, l) => s + l.totalDebtUsd, 0),
  }
}
