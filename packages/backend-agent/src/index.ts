/**
 * Verato Agent Worker
 *
 * Autonomous settlement agent that:
 * 1. Polls the orders API for open signed orders
 * 2. Uses an LLM to evaluate whether to fill them
 * 3. Submits settlement transactions to Verato on Celo
 *
 * Supports both Anthropic (Claude) and OpenAI (GPT) as LLM backends.
 * Set ANTHROPIC_API_KEY or OPENAI_API_KEY as a secret — if both are set,
 * Anthropic is preferred.
 */

import { createWalletClient, http, maxUint256, type Hex, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import {
  encodePermit,
  encodeAaveDelegation,
  encodeMorphoAuthorization,
  encodeApproveToken,
  encodeSettle,
  veratoAbi,
  LenderRange,
} from '@delta-synthesis/settlement-sdk'
import type { StoredPermit } from './order.js'

// Multicall ABI fragment (mutable copy to avoid const narrowing issues with writeContract)
const multicallAbi = [
  {
    name: 'multicall' as const,
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'data', type: 'bytes[]' as const }],
    outputs: [],
  },
]

export interface Env {
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  PRIVATE_KEY: string
  VERATO_ADDRESS: string
  FORWARDER_ADDRESS: string
  CHAIN_ID: string
  RPC_URL: string
  ORDERS_API_URL: string
}

// ── Types ───────────────────────────────────────────────────────────────

interface OpenOrder {
  id: string
  signer: string
  signature: Hex
  order: {
    merkleRoot: Hex
    deadline: number
    settlementData: Hex
    orderData: Hex
    executionData: Hex
    fillerCalldata: Hex
    chainId: number
    maxFeeBps: number
    solver: Address
    minSolverReputation: number
    leaves: Array<{
      op: number
      lenderId: number
      data: Hex
      leaf: Hex
      proof: Hex[]
    }>
  }
  permits?: StoredPermit[]
}

// ── LLM reasoning ──────────────────────────────────────────────────────

function buildPrompt(order: OpenOrder): string {
  return `You are an autonomous DeFi settlement agent operating on the Verato protocol on Celo.

You are evaluating whether to fill the following signed order:

Signer: ${order.signer}
Deadline: ${new Date(order.order.deadline * 1000).toISOString()}
Max Fee BPS: ${order.order.maxFeeBps}
Solver Restriction: ${order.order.solver}
Min Solver Reputation: ${order.order.minSolverReputation}
Chain: Celo (${order.order.chainId})

Permitted operations (Merkle leaves):
${order.order.leaves.map((l) => `  - op: ${l.op}, lenderId: ${l.lenderId}, data: ${l.data}`).join('\n')}

Respond with a JSON object:
{
  "shouldFill": true/false,
  "reason": "brief explanation",
  "fillerCalldata": "0x"  // hex calldata for swaps if needed, or "0x" for none
}

Consider: Is the deadline still valid? Is the fee attractive? Are the operations safe to execute?`
}

async function callAnthropic(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`)
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text: string }>
  }
  return result.content[0]?.text ?? ''
}

async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`)
  }

  const result = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  return result.choices[0]?.message?.content ?? ''
}

async function evaluateOrder(
  env: Env,
  order: OpenOrder
): Promise<{ shouldFill: boolean; reason: string; fillerCalldata: Hex }> {
  const prompt = buildPrompt(order)

  let text: string
  try {
    if (env.ANTHROPIC_API_KEY) {
      text = await callAnthropic(env.ANTHROPIC_API_KEY, prompt)
    } else if (env.OPENAI_API_KEY) {
      text = await callOpenAI(env.OPENAI_API_KEY, prompt)
    } else {
      return {
        shouldFill: false,
        reason: 'No LLM API key configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)',
        fillerCalldata: '0x',
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { shouldFill: false, reason: `LLM error: ${msg}`, fillerCalldata: '0x' }
  }

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')
    const parsed = JSON.parse(jsonMatch[0])
    return {
      shouldFill: parsed.shouldFill === true,
      reason: parsed.reason ?? 'no reason given',
      fillerCalldata: (parsed.fillerCalldata as Hex) ?? '0x',
    }
  } catch {
    return { shouldFill: false, reason: `Failed to parse LLM response: ${text}`, fillerCalldata: '0x' }
  }
}

// ── Settlement execution ────────────────────────────────────────────────

/**
 * Build multicall bundle: permits + token approvals + settle.
 *
 * The agent bundles everything into one atomic multicall so that:
 * 1. User permit signatures (aToken permits, vToken delegation, Morpho auth) are forwarded
 * 2. Token approvals for pools (needed for deposit/repay) are set
 * 3. The actual settle() call executes
 */
function buildMulticallData(
  env: Env,
  order: OpenOrder,
  fillerCalldata: Hex,
): Hex[] {
  const verato = env.VERATO_ADDRESS as Address
  const calls: Hex[] = []

  // 1. Forward user permit signatures
  for (const p of order.permits ?? []) {
    const sig = p.signature
    switch (p.kind) {
      case 'ERC2612_PERMIT':
        calls.push(encodePermit({
          token: p.targetAddress,
          owner: order.signer as Address,
          spender: verato,
          value: maxUint256,
          deadline: BigInt(p.deadline),
          v: sig.v,
          r: sig.r,
          s: sig.s,
        }))
        break

      case 'AAVE_DELEGATION':
        calls.push(encodeAaveDelegation({
          debtToken: p.targetAddress,
          delegator: order.signer as Address,
          delegatee: verato,
          value: maxUint256,
          deadline: BigInt(p.deadline),
          v: sig.v,
          r: sig.r,
          s: sig.s,
        }))
        break

      case 'MORPHO_AUTHORIZATION':
        calls.push(encodeMorphoAuthorization({
          morpho: p.targetAddress,
          authorizer: order.signer as Address,
          authorized: verato,
          isAuthorized: true,
          nonce: BigInt(p.nonce),
          deadline: BigInt(p.deadline),
          v: sig.v,
          r: sig.r,
          s: sig.s,
        }))
        break

      case 'AAVE_DELEGATION_TX':
        // Already executed on-chain by the user, no action needed
        break
    }
  }

  // 2. Approve tokens to pools for DEPOSIT and REPAY operations
  //
  // Leaf data layout by op:
  //   DEPOSIT (0): [20: pool]                          — asset comes from executionData
  //   REPAY   (2): [1: mode][20: debtToken][20: pool]  — asset comes from executionData
  //
  // For Morpho ops (lenderId 4000+), the data layout is different:
  //   [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho]
  //
  // We can't know the exact deposited/repaid token from leaf data alone (it's in
  // executionData), but approveToken is permissionless and idempotent — the contract
  // never holds persistent balances, so max-approving is safe.
  //
  // For Aave-family deposits/repays we extract the pool and approve common Celo assets.
  // For Morpho we don't need pool approvals (Morpho uses transferFrom from the caller).
  const approvedPools = new Set<string>()
  const CELO_ASSETS: Address[] = [
    '0x765DE816845861e75A25fCA122bb6898B8B1282a', // cUSD
    '0xD221812de1BD094f35587EE8E174B07B6167D9Af', // WETH
    '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', // USDC
    '0x48065fbBE25f71C9282ddf5e1cd6D6A887483D5e', // USDT
    '0xd8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73', // cEUR
    '0x471EcE3750Da237f93B8E339c536989b8978a438', // CELO
    '0xe8537a3d056DA446677B9e9d6c5dB704EaAb4787', // cREAL
  ]

  for (const leaf of order.order.leaves) {
    const isAaveFamily = leaf.lenderId <= LenderRange.AAVE_V2.max
    if (!isAaveFamily) continue

    let pool: Address | null = null
    if (leaf.op === 0 /* DEPOSIT */) {
      pool = `0x${leaf.data.slice(2, 42)}` as Address
    } else if (leaf.op === 2 /* REPAY */) {
      // [1: mode][20: debtToken][20: pool]
      pool = `0x${leaf.data.slice(42, 82)}` as Address
    }

    if (pool && !approvedPools.has(pool.toLowerCase())) {
      approvedPools.add(pool.toLowerCase())
      for (const asset of CELO_ASSETS) {
        calls.push(encodeApproveToken(asset, pool))
      }
    }
  }

  // 3. Encode the settle call
  calls.push(encodeSettle({
    maxFeeBps: BigInt(order.order.maxFeeBps),
    solver: order.order.solver,
    minSolverReputation: BigInt(order.order.minSolverReputation),
    deadline: order.order.deadline,
    signature: order.signature,
    orderData: order.order.orderData,
    executionData: order.order.executionData,
    fillerCalldata,
  }))

  return calls
}

async function executeSettlement(env: Env, order: OpenOrder, fillerCalldata: Hex): Promise<Hex> {
  const account = privateKeyToAccount(env.PRIVATE_KEY as Hex)

  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(env.RPC_URL),
  })

  const calls = buildMulticallData(env, order, fillerCalldata)

  // If there's only the settle call (no permits), call settle directly
  // Otherwise use multicall to batch permits + approvals + settle
  if (calls.length === 1) {
    const txHash = await walletClient.writeContract({
      address: env.VERATO_ADDRESS as Address,
      abi: veratoAbi,
      functionName: 'settle',
      args: [
        BigInt(order.order.maxFeeBps),
        order.order.solver,
        BigInt(order.order.minSolverReputation),
        order.order.deadline,
        order.signature,
        order.order.orderData,
        order.order.executionData,
        fillerCalldata,
      ],
    })
    return txHash
  }

  const txHash = await walletClient.writeContract({
    address: env.VERATO_ADDRESS as Address,
    abi: multicallAbi,
    functionName: 'multicall',
    args: [calls],
  })

  return txHash
}

// ── Worker entry point ──────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      const llmProvider = env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : 'none'
      return Response.json({ status: 'ok', agent: 'verato-agent', llmProvider })
    }

    // POST /run — trigger the agent to scan and fill orders
    if (url.pathname === '/run' && request.method === 'POST') {
      try {
        // 1. Fetch open orders
        const ordersRes = await fetch(`${env.ORDERS_API_URL}/orders?status=open`)
        if (!ordersRes.ok) {
          return Response.json({ error: 'Failed to fetch orders' }, { status: 502 })
        }
        const orders = (await ordersRes.json()) as OpenOrder[]

        const results = []

        for (const order of orders) {
          // 2. Check deadline
          if (order.order.deadline < Math.floor(Date.now() / 1000)) {
            results.push({ id: order.id, skipped: true, reason: 'expired' })
            continue
          }

          // 3. LLM evaluation
          const evaluation = await evaluateOrder(env, order)

          if (!evaluation.shouldFill) {
            results.push({ id: order.id, skipped: true, reason: evaluation.reason })
            continue
          }

          // 4. Execute settlement
          try {
            const txHash = await executeSettlement(env, order, evaluation.fillerCalldata)
            results.push({ id: order.id, filled: true, txHash, reason: evaluation.reason })
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            results.push({ id: order.id, filled: false, error: msg })
          }
        }

        return Response.json({ processed: results.length, results })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return Response.json({ error: msg }, { status: 500 })
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  },
} satisfies ExportedHandler<Env>
