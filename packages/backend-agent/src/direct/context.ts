/**
 * Pre-processes order leaves into a SettlementContext — direct API version.
 *
 * Same logic as ../context.ts but calls the 1delta REST API directly
 * instead of going through MCP clients.
 */

import type { Address } from 'viem'
import { fetchUserPositions, fetchLendingMarkets } from './api.js'
import type { PositionItem, MarketEntry } from './api.js'
import type { LeafDescription, StoredOrder } from '../order.js'
import { cometToLender } from '../config/index.js'

// ── Types (re-export from parent for downstream consumers) ───────────────────

export type {
  LeafGroup,
  MarketRates,
  SourceInfo,
  DestinationInfo,
  MigrationOption,
  SettlementContext,
} from '../context.js'

import type {
  LeafGroup,
  MarketRates,
  SourceInfo,
  DestinationInfo,
  MigrationOption,
  SettlementContext,
} from '../context.js'

// Re-use the pure helper from parent (no MCP dependency)
import { groupLeaves } from '../context.js'
export { groupLeaves }

// ── Position matching (same logic, no MCP) ───────────────────────────────────

function matchPositionForGroup(group: LeafGroup, positions: PositionItem[]): PositionItem | null {
  const protocol = group.protocol.toUpperCase()
  for (const item of positions) {
    const lender = String(item.lender ?? '').toUpperCase()
    if (!lender.startsWith(protocol)) continue
    if (group.loanToken || group.collateralToken) {
      const blob = JSON.stringify(item).toLowerCase()
      if (group.loanToken && !blob.includes(group.loanToken.toLowerCase())) continue
      if (group.collateralToken && !blob.includes(group.collateralToken.toLowerCase())) continue
    }
    return item
  }
  return null
}

function getDebtUsd(item: PositionItem): number {
  return ((item.balanceData as Record<string, number> | undefined)?.debt) ?? 0
}

// ── Underlying token resolution ──────────────────────────────────────────────

interface PositionMarket {
  underlying?: string
  collateralEnabled?: boolean
  deposits?: string | number
  debt?: string | number
  collateral?: string | number
}

function resolveUnderlying(
  sourceGroup: LeafGroup,
  sourcePosition: PositionItem,
): { collateralToken: Address; debtToken: Address } | null {
  if (sourceGroup.loanToken && sourceGroup.collateralToken) {
    return {
      debtToken: sourceGroup.loanToken as Address,
      collateralToken: sourceGroup.collateralToken as Address,
    }
  }

  const dataArr = (sourcePosition.data as Record<string, unknown>[] | undefined) ?? []
  const accountData = dataArr[0] as Record<string, unknown> | undefined
  const markets = (accountData?.positions as PositionMarket[] | undefined) ?? []

  let collateralToken: Address | null = null
  let debtToken: Address | null = null

  for (const m of markets) {
    const underlying = m.underlying
    if (!underlying) continue
    const addr = underlying.match(/0x[0-9a-fA-F]{40}/)?.[0] as Address | undefined
    if (!addr) continue
    if (!debtToken && parseFloat(String(m.debt ?? 0)) > 0) debtToken = addr
    if (!collateralToken && (m.collateralEnabled || parseFloat(String(m.collateral ?? 0)) > 0 || parseFloat(String(m.deposits ?? 0)) > 0)) {
      collateralToken = addr
    }
  }

  if (!collateralToken || !debtToken) return null
  return { collateralToken, debtToken }
}

// ── Market rate lookup ───────────────────────────────────────────────────────

function lookupMarketRates(
  markets: MarketEntry[],
  tokenAddress: string,
  protocol: string,
  collateralFilter?: string,
): MarketEntry | null {
  const proto = protocol.toUpperCase()
  const token = tokenAddress.toLowerCase()

  let candidates = markets.filter(m => {
    if (m.tokenAddress?.toLowerCase() !== token) return false
    const lenderFromUid = (m.marketUid ?? '').split(':')[0].toUpperCase()
    return lenderFromUid.startsWith(proto)
  })

  if (candidates.length === 0) return null

  if (collateralFilter && candidates.length > 1) {
    const filtered = candidates.filter(m =>
      (m.marketUid ?? '').toLowerCase().includes(collateralFilter.toLowerCase()),
    )
    if (filtered.length > 0) candidates = filtered
  }

  return candidates[0]
}

function getMarketRates(
  markets: MarketEntry[],
  group: LeafGroup,
  collateralToken: string,
  debtToken: string,
  chainId: number,
): MarketRates {
  const protocol = group.comet
    ? (cometToLender(group.comet, chainId) ?? group.protocol)
    : group.protocol

  const collEntry = lookupMarketRates(markets, collateralToken, protocol)
  const debtEntry = lookupMarketRates(markets, debtToken, protocol, group.collateralToken)

  return {
    collateralDepositRate: collEntry?.depositRate ?? null,
    debtBorrowRate: debtEntry?.variableBorrowRate ?? null,
    collateralLiquidityUsd: collEntry?.availableLiquidityUsd ?? null,
    debtLiquidityUsd: debtEntry?.availableLiquidityUsd ?? null,
  }
}

function resolveDebtBaseUnits(
  debtUsd: number,
  debtToken: string,
  sourceProtocol: string,
  markets: MarketEntry[],
): string {
  const entry = lookupMarketRates(markets, debtToken, sourceProtocol)
  if (entry?.priceUsd && entry?.decimals) {
    const raw = Math.round((debtUsd / entry.priceUsd) * 10 ** entry.decimals)
    return String(raw)
  }
  return String(Math.round(debtUsd * 1e6))
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function buildSettlementContext(
  order: StoredOrder,
  chainId: number,
  leafDescriptions: LeafDescription[],
): Promise<SettlementContext | null> {
  const groups = groupLeaves(leafDescriptions)

  console.log(`\n  Fetching positions for ${order.signer}…`)
  const positions = await fetchUserPositions(order.signer, chainId)

  const sourceCandidates: { group: LeafGroup; position: PositionItem }[] = []
  for (const g of groups) {
    if (g.repayLeafIndex === undefined || g.withdrawLeafIndex === undefined) continue
    const pos = matchPositionForGroup(g, positions)
    if (pos && getDebtUsd(pos) > 0) {
      sourceCandidates.push({ group: g, position: pos })
    }
  }

  if (sourceCandidates.length === 0) {
    console.log('  No source group with active debt found.')
    return null
  }

  console.log('  Fetching all lending markets…')
  const allMarkets = await fetchLendingMarkets(chainId)
  console.log(`  Loaded ${allMarkets.length} market entries`)

  const options: MigrationOption[] = []

  for (const { group: srcGroup, position: srcPos } of sourceCandidates) {
    const tokens = resolveUnderlying(srcGroup, srcPos)
    if (!tokens) {
      console.log(`  Skipping source ${srcGroup.protocol}: could not resolve tokens`)
      continue
    }
    const { collateralToken, debtToken } = tokens
    const debtUsd = getDebtUsd(srcPos)
    const sourceRates = getMarketRates(allMarkets, srcGroup, collateralToken, debtToken, chainId)
    const srcNetYield =
      sourceRates.collateralDepositRate !== null && sourceRates.debtBorrowRate !== null
        ? sourceRates.collateralDepositRate - sourceRates.debtBorrowRate
        : null
    const lender = String(srcPos.lender ?? srcGroup.protocol)
    const debtAmountBaseUnits = resolveDebtBaseUnits(debtUsd, debtToken, srcGroup.protocol, allMarkets)

    const dests: DestinationInfo[] = []
    for (const g of groups.filter(g => g !== srcGroup && g.depositLeafIndex !== undefined && g.borrowLeafIndex !== undefined)) {
      const rates = getMarketRates(allMarkets, g, collateralToken, debtToken, chainId)
      if (rates.collateralDepositRate !== null || rates.debtBorrowRate !== null) {
        const netYield =
          rates.collateralDepositRate !== null && rates.debtBorrowRate !== null
            ? rates.collateralDepositRate - rates.debtBorrowRate
            : null
        const improvement = netYield !== null && srcNetYield !== null ? netYield - srcNetYield : null
        dests.push({ group: g, rates, netYield, improvement })
      }
    }

    console.log(`  Source ${srcGroup.protocol}: net=${srcNetYield?.toFixed(4)} destinations=${dests.length}`)
    options.push({
      source: { group: srcGroup, lender, collateralToken, debtToken, debtAmountBaseUnits, rates: sourceRates },
      destinations: dests,
    })
  }

  if (options.length === 0) {
    console.log('  No viable migration options found.')
    return null
  }

  console.log(`  ${options.length} source option(s) available`)

  return { chainId, orderSigner: order.signer, options }
}
