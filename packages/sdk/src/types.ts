// ── Swap request types ───────────────────────────────────────────────────────

export interface SwapRouteRequest {
  /** Address of the swapper */
  swapper: `0x${string}`
  /** Input token address (use 0x0000...0000 for native ETH) */
  tokenIn: `0x${string}`
  /** Output token address */
  tokenOut: `0x${string}`
  /** Chain ID for input token (as string) */
  tokenInChainId: string
  /** Chain ID for output token (as string) */
  tokenOutChainId: string
  /** Amount in smallest unit (wei for ETH, raw decimals for ERC-20) */
  amount: string
  /** EXACT_INPUT: amount is tokenIn; EXACT_OUTPUT: amount is tokenOut */
  type: 'EXACT_INPUT' | 'EXACT_OUTPUT'
  /** Slippage tolerance as percentage 0-100 */
  slippageTolerance?: number
  /** Routing preference */
  routingPreference?: 'BEST_PRICE' | 'FASTEST' | 'CLASSIC'
  /** Protocol versions to consider */
  protocols?: ('V2' | 'V3' | 'V4')[]
}

// ── Quote response types ─────────────────────────────────────────────────────

export interface TokenAmount {
  token: string
  amount: string
}

export interface ClassicQuote {
  routing: 'CLASSIC'
  quote: {
    input: TokenAmount
    output: TokenAmount
    slippage: number
    route: unknown[]
    gasFee: string
    gasFeeUSD: string
    gasUseEstimate: string
  }
  permitData: unknown | null
}

export interface UniswapXOutput {
  token: string
  startAmount: string
  endAmount: string
  recipient: string
}

export interface UniswapXQuote {
  routing: 'DUTCH_V2' | 'DUTCH_V3' | 'PRIORITY'
  quote: {
    orderInfo: {
      reactor: string
      swapper: string
      nonce: string
      deadline: number
      cosigner: string
      input: { token: string; startAmount: string; endAmount: string }
      outputs: UniswapXOutput[]
      chainId: number
    }
    encodedOrder: string
    orderHash: string
  }
  permitData: { domain: unknown; types: unknown; values: unknown } | null
}

export interface WrapUnwrapQuote {
  routing: 'WRAP' | 'UNWRAP'
  quote: {
    input: TokenAmount
    output: TokenAmount
  }
  permitData: null
}

export type QuoteResponse = ClassicQuote | UniswapXQuote | WrapUnwrapQuote

// ── Config ───────────────────────────────────────────────────────────────────

export interface UniswapConfig {
  apiKey: string
  baseUrl?: string
}
