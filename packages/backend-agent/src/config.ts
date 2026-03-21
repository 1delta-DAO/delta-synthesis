export const ONEDELTA_MCP_URL = 'https://mcp-prototype.1delta.io/mcp'

export const CHAIN_FILTER: string = '42220'
export const DRY_RUN: boolean = false

/**
 * When true, the agent skips settlements where estimated gas cost exceeds
 * the solver fee allowed by the order's maxFeeBps.
 */
export const ECONOMIC_MODE: boolean = false

// Cap tool results to keep context window manageable
export const RESULT_CHAR_LIMIT = 20000

export const CONTRACTS_BY_CHAIN: Record<number, {
  settlement: `0x${string}`
  forwarder:  `0x${string}`
  aaveOracle: `0x${string}`
  morphoPool: `0x${string}`
}> = {
  // Celo mainnet
  42220: {
    settlement: '0x9C2295A43C5b938b079f9057b82E4da7C832753A',
    forwarder:  '0x90d137E4845Ea9C5e4c9Bd8ABf8A1f9f04d0DE65',
    aaveOracle: '0x1e693D088ceFD1E95ba4c4a5F7EeA41a1Ec37e8b',
    morphoPool: '0xBeA21C9b7f6F5e3BfE98A3Ba867FC4Cf34a5f4F3',
  },
}

export const RPC_URL_BY_CHAIN: Record<number, string> = {
  42220: 'https://forno.celo.org',
}

// Not used on Celo but kept for interface compatibility
export const COMPOUND_V3_COMET_TO_LENDER: Record<number, Record<string, string>> = {}

/** Resolve a Compound V3 comet address to its lender name (lowercase comet address). */
export function cometToLender(comet: string, chainId: number): string | null {
  return COMPOUND_V3_COMET_TO_LENDER[chainId]?.[comet.toLowerCase()] ?? null
}

export const CHAIN_NAMES: Record<number, string> = {
  42220: 'celo',
}
