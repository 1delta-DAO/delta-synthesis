export interface AaveTokenEntry {
  aToken: string
  sToken: string
  vToken: string
  symbol: string
}

/** fork → chainId → underlying → token entry */
export type AaveTokensData = Record<string, Record<string, Record<string, AaveTokenEntry>>>

/** poolType → chainId → contract address */
export type MorphoPoolsData = Record<string, Record<string, string>>

export interface TokenSelection {
  collateral: boolean // aToken
  debt: boolean      // vToken
}

export interface SelectionState {
  chainId: string
  aave: {
    fork: string
    tokens: Record<string, TokenSelection> // underlying address → selection
  }
  morpho: {
    pools: string[] // "POOL_TYPE:CHAIN_ID" keys
  }
}

// ── Collected config (derived from selections) ──────────────────────────────

export interface CollectedAaveToken {
  underlying: string
  symbol: string
  collateralToken: string | null // aToken address, null if not selected
  debtToken: string | null       // vToken address, null if not selected
}

export interface CollectedAaveConfig {
  protocol: 'aave'
  fork: string
  chainId: string
  tokens: CollectedAaveToken[]
}

export interface CollectedMorphoPool {
  protocol: 'morpho'
  poolType: string
  chainId: string
  address: string
}

export type CollectedEntry = CollectedAaveConfig | CollectedMorphoPool

export interface CollectedConfig {
  chainId: string
  entries: CollectedEntry[]
}

export const CHAIN_NAMES: Record<string, string> = {
  '1': 'Ethereum',
  '10': 'Optimism',
  '56': 'BNB Chain',
  '137': 'Polygon',
  '250': 'Fantom',
  '8453': 'Base',
  '42161': 'Arbitrum',
  '43114': 'Avalanche',
  '5000': 'Mantle',
  '81457': 'Blast',
  '42220': 'Celo',
}
