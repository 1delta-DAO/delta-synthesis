/**
 * Single source of truth for all agent configuration.
 * Celo-only deployment.
 */

import type { Address } from 'viem'

// ── Feature flags ───────────────────────────────────────────────────────

export const DRY_RUN = false
export const ECONOMIC_MODE = false
export const RESULT_CHAR_LIMIT = 20_000

// ── Chain ───────────────────────────────────────────────────────────────

export const CELO_CHAIN_ID = 42220

export const CHAIN_NAMES: Record<number, string> = {
  42220: 'celo',
}

// ── Contracts ───────────────────────────────────────────────────────────

export const CONTRACTS_BY_CHAIN: Record<number, {
  settlement: Address
  forwarder: Address
  aaveOracle: Address
  morphoPool: Address
}> = {
  42220: {
    settlement: '0x9C2295A43C5b938b079f9057b82E4da7C832753A',
    forwarder:  '0x90d137E4845Ea9C5e4c9Bd8ABf8A1f9f04d0DE65',
    aaveOracle: '0x1e693D088ceFD1E95ba4c4a5F7EeA41a1Ec37e8b',
    morphoPool: '0xBeA21C9b7f6F5e3BfE98A3Ba867FC4Cf34a5f4F3',
  },
}

// ── RPCs ────────────────────────────────────────────────────────────────

export const RPC_URL_BY_CHAIN: Record<number, string> = {
  42220: 'https://forno.celo.org',
}

/** Multiple Celo RPCs for retry (ordered by observed latency). */
export const CELO_RPC_URLS = [
  'https://celo.drpc.org',
  'https://forno.celo.org',
  'https://rpc.ankr.com/celo',
  'https://celo-mainnet.gateway.tatum.io',
]

// ── Portal proxy ────────────────────────────────────────────────────────

export const PORTAL_PROXY_URL = 'https://portal-proxy.achim-d87.workers.dev'

// ── Compound V3 (not used on Celo, kept for interface compat) ───────────

export function cometToLender(_comet: string, _chainId: number): string | null {
  return null
}
