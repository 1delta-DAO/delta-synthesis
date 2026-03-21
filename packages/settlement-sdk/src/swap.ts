import type { Address, Hex } from 'viem'
import type { FillerSwap } from './settlement/types.js'
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

// ── Build a FillerSwap from a Uniswap quote ─────────────────────────────────

export interface BuildFillerSwapRequest {
  /** Input token address */
  assetIn: Address
  /** Output token address */
  assetOut: Address
  /** Amount in smallest unit. Use 0n if the contract already holds the tokens (e.g. from a preceding withdraw). */
  amountIn: bigint
  /** Chain ID (as string, e.g. "42220" for Celo) */
  chainId: string
  /** Slippage tolerance as percentage 0-100 (e.g. 0.5 for 0.5%) */
  slippageTolerance?: number
  /** Address that will call the DEX — should be the SettlementForwarder */
  forwarderAddress: Address
}

/**
 * Fetch a Uniswap quote and build a ready-to-use FillerSwap object.
 *
 * The returned FillerSwap can be passed directly to `encodeFillerCalldata()`.
 * Only CLASSIC (AMM) routes are supported — UniswapX Dutch auctions are not
 * compatible with the Verato forwarder execution model.
 *
 * @param request - Swap parameters
 * @param config  - Uniswap Trading API config (apiKey, optional baseUrl)
 * @returns FillerSwap ready for settlement encoding
 */
export async function buildFillerSwap(
  request: BuildFillerSwapRequest,
  config: UniswapConfig,
): Promise<FillerSwap> {
  const quote = await fetchSwapRoute(
    {
      swapper: request.forwarderAddress,
      tokenIn: request.assetIn,
      tokenOut: request.assetOut,
      tokenInChainId: request.chainId,
      tokenOutChainId: request.chainId,
      amount: request.amountIn > 0n ? request.amountIn.toString() : '0',
      type: 'EXACT_INPUT',
      slippageTolerance: request.slippageTolerance ?? 0.5,
      routingPreference: 'CLASSIC',
    },
    config,
  )

  if (quote.routing !== 'CLASSIC') {
    throw new Error(
      `Expected CLASSIC route but got ${quote.routing}. ` +
      `Verato settlement requires AMM routing (use routingPreference: "CLASSIC").`,
    )
  }

  const classic = quote as ClassicQuote
  const mp = classic.quote.methodParameters

  if (!mp?.calldata || !mp?.to) {
    throw new Error(
      'Uniswap quote did not return methodParameters. ' +
      'Ensure the Trading API is configured to return calldata.',
    )
  }

  return {
    assetIn: request.assetIn,
    assetOut: request.assetOut,
    amountIn: request.amountIn,
    target: mp.to as Address,
    swapCalldata: mp.calldata as Hex,
  }
}

/**
 * Build a FillerSwap from a pre-fetched Uniswap CLASSIC quote.
 *
 * Use this when you already have a quote (e.g. for display/confirmation)
 * and want to convert it to a FillerSwap without re-fetching.
 */
export function fillerSwapFromQuote(
  quote: ClassicQuote,
  assetIn: Address,
  assetOut: Address,
  amountIn: bigint,
): FillerSwap {
  const mp = quote.quote.methodParameters

  if (!mp?.calldata || !mp?.to) {
    throw new Error(
      'Quote does not contain methodParameters. ' +
      'Only CLASSIC quotes with calldata are supported.',
    )
  }

  return {
    assetIn,
    assetOut,
    amountIn,
    target: mp.to as Address,
    swapCalldata: mp.calldata as Hex,
  }
}
