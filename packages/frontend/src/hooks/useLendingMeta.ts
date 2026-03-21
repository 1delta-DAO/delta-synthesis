import { useState, useEffect } from 'react'
import { PORTAL_PROXY_URL } from '../config/constants'

export interface LenderInfo {
  key: string
  name: string
  logoURI?: string
}

interface LatestItem {
  lenderKey: string
  lenderInfo: LenderInfo
}

interface LatestResponse {
  success: boolean
  data: {
    count: number
    items: LatestItem[]
  }
}

/**
 * Fetches lender metadata from the portal lending/latest endpoint.
 * Returns a map of lenderKey -> LenderInfo, covering all protocol families.
 */
export function useLendingMeta(chainId: number | null) {
  const [lenders, setLenders] = useState<Record<string, LenderInfo>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!chainId) {
      setLenders({})
      return
    }

    let cancelled = false
    setLoading(true)

    async function fetchMeta() {
      try {
        const params = new URLSearchParams({
          chains: String(chainId),
          count: '1000',
        })

        const res = await fetch(
          `${PORTAL_PROXY_URL}/v1/data/lending/latest?${params.toString()}`,
        )
        if (!res.ok) return

        const json: LatestResponse = await res.json()
        if (!json.success) return

        const map: Record<string, LenderInfo> = {}
        for (const item of json.data.items) {
          if (item.lenderInfo && !map[item.lenderKey]) {
            map[item.lenderKey] = item.lenderInfo
          }
        }
        if (!cancelled) setLenders(map)
      } catch {
        // silently fail — fallback to raw protocol IDs
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchMeta()
    return () => { cancelled = true }
  }, [chainId])

  return { lenders, loading }
}

/** Look up lender info with a fallback for unknown protocols */
export function resolveLender(lenders: Record<string, LenderInfo>, protocolId: string): LenderInfo {
  const info = lenders[protocolId]
  if (info) return info
  return {
    key: protocolId,
    name: protocolId.replace(/_/g, ' '),
  }
}
