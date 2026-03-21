/**
 * Settlement context types and leaf grouping logic.
 */

import type { Address } from 'viem'
import type { LeafDescription } from './order.js'

// ── Types ───────────────────────────────────────────────────────────────

export interface LeafGroup {
  protocol: string
  loanToken?: string
  collateralToken?: string
  comet?: string
  depositLeafIndex?: number
  borrowLeafIndex?: number
  repayLeafIndex?: number
  withdrawLeafIndex?: number
}

export interface MarketRates {
  collateralDepositRate: number | null
  debtBorrowRate: number | null
  collateralLiquidityUsd: number | null
  debtLiquidityUsd: number | null
}

export interface SourceInfo {
  group: LeafGroup
  lender: string
  collateralToken: Address
  debtToken: Address
  debtAmountBaseUnits: string
  rates: MarketRates
}

export interface DestinationInfo {
  group: LeafGroup
  rates: MarketRates
  netYield: number | null
  improvement: number | null
}

export interface MigrationOption {
  source: SourceInfo
  destinations: DestinationInfo[]
}

export interface SettlementContext {
  chainId: number
  orderSigner: string
  options: MigrationOption[]
}

// ── Leaf grouping ───────────────────────────────────────────────────────

/**
 * Groups leaf descriptions by protocol (and Morpho market params).
 * Each group collects the leaf indices for deposit/borrow/repay/withdraw
 * operations at the same lender.
 */
export function groupLeaves(leaves: LeafDescription[]): LeafGroup[] {
  const map = new Map<string, LeafGroup>()

  for (const leaf of leaves) {
    // Use protocol + morpho market identifiers as group key
    const key = leaf.loanToken
      ? `${leaf.protocol}:${leaf.loanToken}:${leaf.collateralToken}`
      : leaf.protocol

    let group = map.get(key)
    if (!group) {
      group = {
        protocol: leaf.protocol,
        loanToken: leaf.loanToken,
        collateralToken: leaf.collateralToken,
      }
      map.set(key, group)
    }

    switch (leaf.op) {
      case 'DEPOSIT':
        group.depositLeafIndex = leaf.index
        break
      case 'BORROW':
        group.borrowLeafIndex = leaf.index
        break
      case 'REPAY':
        group.repayLeafIndex = leaf.index
        break
      case 'WITHDRAW':
        group.withdrawLeafIndex = leaf.index
        break
    }
  }

  return Array.from(map.values())
}
