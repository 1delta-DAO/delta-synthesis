/**
 * Re-exports shared config from the parent module.
 * Direct mode uses the same contracts, RPCs, and feature flags.
 */
export {
  CHAIN_FILTER,
  DRY_RUN,
  ECONOMIC_MODE,
  RESULT_CHAR_LIMIT,
  CONTRACTS_BY_CHAIN,
  RPC_URL_BY_CHAIN,
  cometToLender,
  CHAIN_NAMES,
} from '../config.js'

/** Portal proxy URL for lending data (positions, markets). */
export const PORTAL_PROXY_URL = 'https://portal-proxy.achim-d87.workers.dev'

/** Celo RPC URLs for executing on-chain calls (ordered by latency). */
export const CELO_RPC_URLS = [
  'https://celo.drpc.org',
  'https://forno.celo.org',
  'https://rpc.ankr.com/celo',
  'https://celo-mainnet.gateway.tatum.io',
]
