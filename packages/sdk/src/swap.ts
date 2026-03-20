import type {
  SwapRouteRequest,
  QuoteResponse,
  UniswapConfig,
  ClassicQuote,
  UniswapXQuote,
} from './types.js'

const DEFAULT_BASE_URL = 'https://trade-api.gateway.uniswap.org/v1'

const REQUIRED_HEADERS = {
  'Content-Type': 'application/json',
  'x-universal-router-version': '2.0',
} as const

function headers(apiKey: string): Record<string, string> {
  return { ...REQUIRED_HEADERS, 'x-api-key': apiKey }
}

/**
 * Fetch a Uniswap swap route (quote) for a given token pair and amount.
 *
 * Returns the best available route via the Trading API, which may be
 * a CLASSIC AMM route or a UniswapX Dutch auction depending on the pair/chain.
 */
export async function fetchSwapRoute(
  request: SwapRouteRequest,
  config: UniswapConfig,
): Promise<QuoteResponse> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL

  const body = {
    swapper: request.swapper,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    tokenInChainId: request.tokenInChainId,
    tokenOutChainId: request.tokenOutChainId,
    amount: request.amount,
    type: request.type,
    slippageTolerance: request.slippageTolerance ?? 0.5,
    routingPreference: request.routingPreference ?? 'BEST_PRICE',
    ...(request.protocols ? { protocols: request.protocols } : {}),
  }

  const res = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: headers(config.apiKey),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Uniswap quote failed (${res.status}): ${text}`)
  }

  return (await res.json()) as QuoteResponse
}

// ── Helpers to extract output amount from any quote type ─────────────────────

export function getOutputAmount(quote: QuoteResponse): string {
  switch (quote.routing) {
    case 'CLASSIC':
      return (quote as ClassicQuote).quote.output.amount
    case 'DUTCH_V2':
    case 'DUTCH_V3':
    case 'PRIORITY':
      return (quote as UniswapXQuote).quote.orderInfo.outputs[0].startAmount
    case 'WRAP':
    case 'UNWRAP':
      return quote.quote.output.amount
    default:
      throw new Error(`Unknown routing type: ${(quote as QuoteResponse).routing}`)
  }
}

export function getGasFeeUSD(quote: QuoteResponse): string | null {
  if (quote.routing === 'CLASSIC') {
    return (quote as ClassicQuote).quote.gasFeeUSD
  }
  // UniswapX routes are gasless for the swapper
  return null
}
