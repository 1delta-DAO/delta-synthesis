/**
 * Pool data fetcher — lightweight endpoint for evaluating migration destinations.
 */

import type { Address } from 'viem'
import { PORTAL_PROXY_URL } from '../config/index.js'

export interface PoolInfo {
  marketUid: string
  lenderKey: string
  name: string
  token: Address
  symbol: string
  decimals: number
  depositRate: number
  variableBorrowRate: number
  totalDepositsUsd: number
  totalLiquidityUsd: number
  borrowingEnabled: boolean
  collateralActive: boolean
  logoURI?: string
}

interface PoolApiResponse {
  success: boolean
  data: {
    items: Array<{
      marketUid: string
      lenderKey: string
      name: string
      depositRate: number
      variableBorrowRate: number
      totalDepositsUsd: number
      totalLiquidityUsd: number
      flags: {
        isActive: boolean
        isFrozen: boolean
        borrowingEnabled: boolean
        collateralActive: boolean
      }
      underlyingInfo: {
        asset: {
          address: string
          symbol: string
          decimals: number
          logoURI?: string
        }
      }
    }>
  }
}

/**
 * Fetch all active pools on a chain from the portal proxy.
 */
export async function fetchPools(chainId: number): Promise<PoolInfo[]> {
  const res = await fetch(`${PORTAL_PROXY_URL}/v1/data/lending/pools?chainId=${chainId}`)
  if (!res.ok) throw new Error(`Pools endpoint: ${res.status}`)

  const json = await res.json() as PoolApiResponse
  if (!json.success) return []

  return json.data.items
    .filter(p => p.flags.isActive && !p.flags.isFrozen)
    .map(p => ({
      marketUid: p.marketUid,
      lenderKey: p.lenderKey,
      name: p.name,
      token: p.underlyingInfo.asset.address as Address,
      symbol: p.underlyingInfo.asset.symbol,
      decimals: p.underlyingInfo.asset.decimals,
      depositRate: p.depositRate,
      variableBorrowRate: p.variableBorrowRate,
      totalDepositsUsd: p.totalDepositsUsd,
      totalLiquidityUsd: p.totalLiquidityUsd,
      borrowingEnabled: p.flags.borrowingEnabled,
      collateralActive: p.flags.collateralActive,
      logoURI: p.underlyingInfo.asset.logoURI,
    }))
}
