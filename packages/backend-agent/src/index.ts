/**
 * Verato Agent Worker
 *
 * Autonomous settlement agent that:
 * 1. Polls the orders API for open signed orders
 * 2. Uses an LLM to evaluate whether to fill them
 * 3. Submits settlement transactions to Verato on Celo
 */

import { createWalletClient, createPublicClient, http, type Hex, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'

export interface Env {
  ANTHROPIC_API_KEY: string
  PRIVATE_KEY: string
  VERATO_ADDRESS: string
  FORWARDER_ADDRESS: string
  CHAIN_ID: string
  RPC_URL: string
  ORDERS_API_URL: string
}

// ── Verato ABI (settle function) ────────────────────────────────────────

const vertatoSettleAbi = [
  {
    name: 'settle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'maxFeeBps', type: 'uint256' },
      { name: 'solver', type: 'address' },
      { name: 'minSolverReputation', type: 'uint256' },
      { name: 'deadline', type: 'uint48' },
      { name: 'signature', type: 'bytes' },
      { name: 'orderData', type: 'bytes' },
      { name: 'executionData', type: 'bytes' },
      { name: 'fillerCalldata', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

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
}

// ── LLM reasoning ──────────────────────────────────────────────────────

async function evaluateOrder(
  env: Env,
  order: OpenOrder
): Promise<{ shouldFill: boolean; reason: string; fillerCalldata: Hex }> {
  const prompt = `You are an autonomous DeFi settlement agent operating on the Verato protocol on Celo.

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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    return { shouldFill: false, reason: `LLM error: ${response.status}`, fillerCalldata: '0x' }
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text: string }>
  }
  const text = result.content[0]?.text ?? ''

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

async function executeSettlement(env: Env, order: OpenOrder, fillerCalldata: Hex): Promise<Hex> {
  const account = privateKeyToAccount(env.PRIVATE_KEY as Hex)

  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(env.RPC_URL),
  })

  const txHash = await walletClient.writeContract({
    address: env.VERATO_ADDRESS as Address,
    abi: vertatoSettleAbi,
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

// ── Worker entry point ──────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', agent: 'verato-agent' })
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
