/**
 * Direct HTTP calls to the portal proxy API for lending data.
 *
 * Uses the same endpoints as the frontend:
 *   - /v1/data/lending/user-positions/rpc-call + /parse  (positions)
 *   - /v1/data/lending/latest                            (markets)
 */

import { PORTAL_PROXY_URL, CELO_RPC_URLS } from './config.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface AssetInfo {
  chainId: string
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI?: string
}

export interface PositionEntry {
  marketUid: string
  deposits: string
  debt: string
  depositsUSD: number
  debtUSD: number
  collateralEnabled: boolean
  underlyingInfo: {
    asset: AssetInfo
    oraclePrice?: { oraclePrice: number; oraclePriceUsd: number }
  }
}

export interface AccountData {
  accountId: string
  health: number
  borrowCapacityUSD: number
  balanceData: {
    deposits: number
    debt: number
    collateral: number
    nav: number
  }
  positions: PositionEntry[]
}

export interface LenderPositions {
  lender: string
  chainId: string
  account: string
  data: AccountData[]
}

/** Flattened position item for backward compatibility with context.ts */
export interface PositionItem {
  lender: string
  chainId: string
  account: string
  balanceData?: { debt: number; deposits: number; collateral: number; nav: number }
  data?: AccountData[]
  // Allow arbitrary fields for downstream matching
  [key: string]: unknown
}

export interface MarketEntry {
  marketUid?: string
  tokenAddress?: string
  depositRate?: number
  variableBorrowRate?: number
  availableLiquidityUsd?: number
  priceUsd?: number
  decimals?: number
}

// ── RPC execution with retry ────────────────────────────────────────────────

async function rpcCallWithRetry(
  rpcCalls: unknown[],
): Promise<unknown> {
  const errors: string[] = []

  for (const url of CELO_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcCalls),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`)
        continue
      }
      const json = await res.json()
      if (Array.isArray(json) && json.some((r: { error?: unknown }) => r.error)) {
        errors.push(`${url}: JSON-RPC error`)
        continue
      }
      return json
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  throw new Error(`All RPCs failed: ${errors.join(' | ')}`)
}

// ── API calls ───────────────────────────────────────────────────────────────

/**
 * Fetch all lending positions for an account on a given chain.
 * Uses the portal proxy's 3-step RPC flow:
 *   1. GET  /user-positions/rpc-call  → batched eth_call specs
 *   2. Execute on-chain via public RPCs
 *   3. POST /user-positions/parse     → parsed position data
 */
export async function fetchUserPositions(
  account: string,
  chainId: number,
): Promise<PositionItem[]> {
  // Step 1: Get RPC call specs
  const params = new URLSearchParams({
    account,
    chain: String(chainId),
    batchSize: '4096',
    blockTag: 'latest',
  })

  const rpcCallRes = await fetch(
    `${PORTAL_PROXY_URL}/v1/data/lending/user-positions/rpc-call?${params}`,
  )
  if (!rpcCallRes.ok) throw new Error(`Position rpc-call: ${rpcCallRes.status}`)

  const rpcCallData = await rpcCallRes.json() as {
    success: boolean
    data: { rpcCallId: string; rpcCalls: unknown[] }
  }
  if (!rpcCallData.success) throw new Error('Failed to get position RPC specs')

  const { rpcCallId, rpcCalls } = rpcCallData.data

  // Step 2: Execute on-chain
  const rawResponses = await rpcCallWithRetry(rpcCalls)

  // Step 3: Parse results
  const parseRes = await fetch(
    `${PORTAL_PROXY_URL}/v1/data/lending/user-positions/parse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rpcCallId, rawResponses }),
    },
  )
  if (!parseRes.ok) throw new Error(`Position parse: ${parseRes.status}`)

  const parsed = await parseRes.json() as {
    success: boolean
    data?: { items: LenderPositions[] }
    error?: { message: string }
  }
  if (!parsed.success || !parsed.data) {
    throw new Error(parsed.error?.message ?? 'Failed to parse positions')
  }

  // Convert to PositionItem[] for backward compat with context.ts
  return parsed.data.items.map((lp): PositionItem => ({
    lender: lp.lender,
    chainId: lp.chainId,
    account: lp.account,
    balanceData: lp.data[0]?.balanceData,
    data: lp.data,
  }))
}

/**
 * Fetch all lending markets for a chain.
 * Uses the portal proxy's /v1/data/lending/latest endpoint.
 */
export async function fetchLendingMarkets(
  chainId: number,
  count = 1000,
): Promise<MarketEntry[]> {
  const params = new URLSearchParams({
    chains: String(chainId),
    count: String(count),
  })

  const res = await fetch(`${PORTAL_PROXY_URL}/v1/data/lending/latest?${params}`)
  if (!res.ok) throw new Error(`Markets endpoint: ${res.status}`)

  const json = await res.json() as {
    success: boolean
    data: {
      items: Array<{
        lenderKey: string
        markets: Array<{
          marketUid: string
          depositRate: number
          variableBorrowRate: number
          totalLiquidityUsd: number
          underlyingInfo: {
            asset: { address: string; decimals: number }
            prices: { priceUsd: number }
          }
        }>
      }>
    }
  }
  if (!json.success) return []

  // Flatten all markets across lenders into MarketEntry[]
  const entries: MarketEntry[] = []
  for (const lender of json.data.items) {
    for (const m of lender.markets) {
      entries.push({
        marketUid: m.marketUid,
        tokenAddress: m.underlyingInfo?.asset?.address,
        depositRate: m.depositRate,
        variableBorrowRate: m.variableBorrowRate,
        availableLiquidityUsd: m.totalLiquidityUsd,
        priceUsd: m.underlyingInfo?.prices?.priceUsd,
        decimals: m.underlyingInfo?.asset?.decimals,
      })
    }
  }

  return entries
}
