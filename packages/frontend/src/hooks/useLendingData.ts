import { useState, useEffect } from 'react'
import { PORTAL_PROXY_URL } from '../config/constants'

// ── Aave market types ───────────────────────────────────────────────────

export interface AaveMarketParams {
  metadata: {
    aToken: string
    vToken: string
    sToken: string
  }
}

export interface AaveMarket {
  marketUid: string
  name: string
  totalDepositsUsd: number
  totalDebtUsd: number
  totalLiquidityUsd: number
  depositRate: number
  variableBorrowRate: number
  utilization: number
  flags: {
    isActive: boolean
    isFrozen: boolean
    borrowingEnabled: boolean
    collateralActive: boolean
  }
  caps: {
    borrowCap: number
    supplyCap: number
  }
  underlyingInfo: {
    asset: {
      address: string
      symbol: string
      name: string
      decimals: number
      logoURI?: string
    }
    prices: {
      priceUsd: number
    }
  }
  params: AaveMarketParams
}

// ── Morpho market types ─────────────────────────────────────────────────

export interface MorphoMarketParams {
  market: {
    lender: string
    id: string
    collateralDecimals: number
    loanDecimals: number
    lltv: string
    oracle: string
    irm: string
    collateralAddress: string
    loanAddress: string
    fee: string
  }
}

export interface MorphoMarket {
  marketUid: string
  name: string
  totalDepositsUsd: number
  totalDebtUsd: number
  tvlUsd: number
  depositRate: number
  variableBorrowRate: number
  underlyingInfo: {
    asset: {
      address: string
      symbol: string
      name: string
      decimals: number
      logoURI?: string
    }
    prices: {
      priceUsd: number
    }
  }
  params: MorphoMarketParams
}

// ── Lender item (from API) ──────────────────────────────────────────────

export interface LenderItem {
  chainId: string
  lenderKey: string
  lenderInfo: {
    key: string
    name: string
    logoURI?: string
  }
  totalDepositsUsd: number
  totalDebtUsd: number
  tvlUsd: number
  markets: Array<AaveMarket | MorphoMarket>
}

interface LendingResponse {
  success: boolean
  data: {
    count: number
    items: LenderItem[]
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function isAaveLender(key: string): boolean {
  return key === 'AAVE_V3' || key === 'MOOLA' || key.startsWith('AAVE_V3_')
}

export function isMorphoLender(key: string): boolean {
  return key.startsWith('MORPHO_BLUE')
}

export function isAaveMarket(market: AaveMarket | MorphoMarket): market is AaveMarket {
  const p = market.params as AaveMarketParams
  return p?.metadata?.aToken !== undefined
}

export function isMorphoMarket(market: AaveMarket | MorphoMarket): market is MorphoMarket {
  const p = market.params as MorphoMarketParams
  return p?.market?.lltv !== undefined
}

// ── Hook ────────────────────────────────────────────────────────────────

export function useLendingData(chainId: string | null) {
  const [lenders, setLenders] = useState<LenderItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!chainId) {
      setLenders([])
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    async function fetchData() {
      try {
        const params = new URLSearchParams({
          chains: chainId!,
          count: '1000',
        })
        const res = await fetch(`${PORTAL_PROXY_URL}/v1/data/lending/latest?${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: LendingResponse = await res.json()
        if (!json.success) throw new Error('API returned success=false')
        if (!cancelled) setLenders(json.data.items)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchData()
    return () => { cancelled = true }
  }, [chainId])

  return { lenders, loading, error }
}
