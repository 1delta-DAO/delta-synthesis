import { useState, useEffect } from 'react'
import { PORTAL_PROXY_URL } from '../config/constants'

// ── Types ────────────────────────────────────────────────────────

export interface AssetInfo {
  chainId: string
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI?: string
}

export interface Position {
  marketUid: string
  deposits: string
  debt: string
  depositsUSD: number
  debtUSD: number
  collateralEnabled: boolean
  /** Per-asset supply APR (already in %, e.g. 3.5 = 3.5%) */
  depositApr?: number | null
  /** Per-asset borrow APR (already in %, e.g. 5.2 = 5.2%) */
  borrowApr?: number | null
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
  aprData: {
    apr: number
    depositApr: number
    borrowApr: number
  }
  positions: Position[]
}

export interface LenderPositions {
  lender: string
  chainId: string
  account: string
  data: AccountData[]
}

// ── RPC call response ────────────────────────────────────────────

interface RpcCallResponse {
  success: boolean
  data: {
    rpcCallId: string
    rpcCalls: Array<{
      jsonrpc: string
      id: number
      method: string
      params: [{ to: string; data: string }, string]
    }>
  }
}

interface ParseResponse {
  success: boolean
  data?: {
    items: LenderPositions[]
  }
  error?: { code: string; message: string }
}

// ── RPC URLs per chain (multiple for retry) ──────────────────────

const RPC_URLS: Record<number, string[]> = {
  42220: [
    'https://celo.drpc.org',
    'https://forno.celo.org',
    'https://rpc.ankr.com/celo',
    'https://celo-mainnet.gateway.tatum.io',
  ],
}

/**
 * Execute an RPC call with retry across multiple endpoints.
 * Tries each URL once, returns the first successful response.
 */
async function rpcCallWithRetry(
  chainId: number,
  body: unknown,
): Promise<unknown> {
  const urls = RPC_URLS[chainId]
  if (!urls || urls.length === 0) throw new Error(`No RPC URLs for chain ${chainId}`)

  const errors: string[] = []

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`)
        continue
      }
      const json = await res.json()
      // Check for JSON-RPC error in the response
      if (Array.isArray(json)) {
        const hasError = json.some((r: { error?: unknown }) => r.error)
        if (hasError) {
          errors.push(`${url}: JSON-RPC error`)
          continue
        }
      } else if (json.error) {
        errors.push(`${url}: ${json.error.message ?? 'JSON-RPC error'}`)
        continue
      }
      return json
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  throw new Error(`All RPCs failed for chain ${chainId}: ${errors.join(' | ')}`)
}

// ── Hook ─────────────────────────────────────────────────────────

/**
 * Fetches user lending positions via a two-step RPC flow:
 *  1. GET  /user-positions/rpc-call  → returns batched eth_call specs
 *  2. Execute the calls on-chain via the chain's public RPC (with retry)
 *  3. POST /user-positions/parse     → returns parsed position data
 */
export function useUserPositions(
  account: string | undefined,
  chainId: number | null,
) {
  const [positions, setPositions] = useState<LenderPositions[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!account || !chainId) {
      setPositions([])
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    async function fetchPositions() {
      try {
        // Step 1: Get RPC call specs (no lender filter = all lenders)
        const params = new URLSearchParams({
          account: account!,
          chain: String(chainId),
          batchSize: '4096',
          blockTag: 'latest',
        })

        const rpcCallRes = await fetch(
          `${PORTAL_PROXY_URL}/v1/data/lending/user-positions/rpc-call?${params.toString()}`,
        )
        if (!rpcCallRes.ok) throw new Error(`RPC call endpoint: ${rpcCallRes.status}`)

        const rpcCallData: RpcCallResponse = await rpcCallRes.json()
        if (!rpcCallData.success) throw new Error('Failed to get RPC call spec')

        const { rpcCallId, rpcCalls } = rpcCallData.data

        // Step 2: Execute on-chain with retry across multiple RPCs
        const rawResponses = await rpcCallWithRetry(chainId!, rpcCalls)

        // Step 3: Parse results
        const parseRes = await fetch(
          `${PORTAL_PROXY_URL}/v1/data/lending/user-positions/parse`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rpcCallId, rawResponses }),
          },
        )
        if (!parseRes.ok) throw new Error(`Parse endpoint: ${parseRes.status}`)

        const parsed: ParseResponse = await parseRes.json()
        if (!parsed.success || !parsed.data) {
          throw new Error(parsed.error?.message ?? 'Failed to parse positions')
        }

        if (!cancelled) setPositions(parsed.data.items)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchPositions()
    return () => { cancelled = true }
  }, [account, chainId])

  return { positions, loading, error }
}
