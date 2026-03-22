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

import { createWalletClient, createPublicClient, http, maxUint256, erc20Abi, type Hex, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import {
  encodePermit,
  encodeAaveDelegation,
  encodeMorphoAuthorization,
  encodeApproveToken,
  encodeSettle,
  encodeSettleWithFlashLoan,
  veratoAbi,
  LenderRange,
  buildFillerSwap,
} from '@delta-synthesis/settlement-sdk'
import type { StoredPermit } from './order.js'
import { describeLeaves } from './order.js'
import { fetchUserPositions } from './direct/api.js'
import type { LenderPositions } from './direct/api.js'
import { interpretPositions, fetchPools, evaluateMigrations, buildCollateralMigration, buildCollateralSwapMigration, buildDebtMigration } from './interpret/index.js'
import { initWallet, runAllSettlements } from './direct/index.js'
import { setProviderKeys } from './providers/index.js'

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
  UNISWAP_API_KEY?: string
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
  return `You are an autonomous DeFi settlement agent on Verato (Celo). You earn fees from the maxFeeBps allowance on borrow surplus. Gas on Celo is extremely cheap (~$0.001 per tx), so even very small fees are profitable.

Order:
- Deadline: ${new Date(order.order.deadline * 1000).toISOString()}
- Max Fee: ${(order.order.maxFeeBps / 1e7 * 100).toFixed(4)}% (${order.order.maxFeeBps} in 1e7 units)
- Solver: ${order.order.solver === '0x0000000000000000000000000000000000000000' ? 'permissionless' : order.order.solver}
- Operations: ${order.order.leaves.length} permitted lending ops

Respond with JSON only: { "shouldFill": true/false, "reason": "brief" }

Decision rules:
- ACCEPT if deadline is in the future. Any fee > 0 is profitable on Celo.
- REJECT only if deadline has passed.`
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
    // Strip JS-style comments that LLMs sometimes add inside JSON
    const cleaned = jsonMatch[0].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const parsed = JSON.parse(cleaned)
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
    '0x765de816845861e75a25fca122bb6898b8b1282a', // cUSD
    '0xd221812de1bd094f35587ee8e174b07b6167d9af', // WETH
    '0xceba9300f2b948710d2653dd7b07f33a8b32118c', // USDC
    '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', // USDT
    '0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73', // cEUR
    '0x471ece3750da237f93b8e339c536989b8978a438', // CELO
    '0xe8537a3d056da446677b9e9d6c5db704eaab4787', // cREAL
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

async function executeSettlement(env: Env, order: OpenOrder, _llmFillerCalldata: Hex): Promise<Hex> {
  const account = privateKeyToAccount(env.PRIVATE_KEY as Hex)
  const chainId = parseInt(env.CHAIN_ID)
  const verato = env.VERATO_ADDRESS as Address

  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(env.RPC_URL),
  })

  // ── Build executionData from positions + leaves ──────────────
  // The order has executionData=0x — the agent must construct it.
  const leafDescriptions = describeLeaves(order.order.leaves.map(l => ({
    ...l,
    lenderId: l.lenderId ?? (l as any).lender ?? 0,
  })))

  let rawPositions: any[]
  try {
    rawPositions = await fetchUserPositions(order.signer, chainId)
  } catch (e) {
    console.log(`  Position fetch failed: ${e instanceof Error ? e.message : e}`)
    rawPositions = []
  }
  const userSummary = interpretPositions(order.signer, String(chainId), rawPositions as unknown as LenderPositions[])
  console.log(`  User: lenders=${userSummary.lenders.length} debt=$${userSummary.totalDebtUsd.toFixed(2)} deposits=$${userSummary.totalDepositsUsd.toFixed(2)}`)

  let executionData: Hex = '0x'
  let fillerCalldata: Hex = '0x'

  if (!userSummary.hasAnyDebt && userSummary.lenders.length > 0) {
    // Collateral-only migration
    const pools = await fetchPools(chainId)
    console.log(`  Pools: ${pools.length}`)
    const evaluation = evaluateMigrations(userSummary, pools, leafDescriptions)
    console.log(`  Candidates: ${evaluation.candidates.length} best: ${evaluation.bestCandidate?.type ?? 'none'}`)

    // Prefer collateral_only (no swap needed), fall back to collateral_swap if we have a Uniswap key
    const collateralOnly = evaluation.candidates.find(c => c.type === 'collateral_only')
    const collateralSwap = evaluation.candidates.find(c => c.type === 'collateral_swap')
    const best = collateralOnly ?? (env.UNISWAP_API_KEY ? collateralSwap : null) ?? evaluation.bestCandidate

    if (best && (best.type === 'collateral_only' || best.type === 'collateral_swap')) {
      const storedOrder = {
        id: order.id, createdAt: 0, status: 'open' as const,
        signer: order.signer as Address, signature: order.signature,
        order: order.order, permits: order.permits ?? [],
      }

      let built: { executionData: Hex; fillerCalldata: Hex }

      if (best.type === 'collateral_only') {
        console.log(`  Building collateral migration: ${best.symbol} ${best.sourceLender} → ${best.destLender}`)
        built = buildCollateralMigration(storedOrder, best, verato, account.address)
      } else {
        // collateral_swap — need Uniswap quote
        if (!env.UNISWAP_API_KEY) {
          console.log(`  Swap candidate found but no UNISWAP_API_KEY — skipping`)
          built = { executionData: '0x' as Hex, fillerCalldata: '0x' as Hex }
        } else {
          console.log(`  Building collateral swap: ${best.sourceSymbol} → ${best.destSymbol} (${best.sourceLender} → ${best.destLender})`)

          try {
            const forwarder = env.FORWARDER_ADDRESS as Address

            // Read user's aToken balance to get exact withdraw amount for the quote
            const withdrawLeaf = order.order.leaves[best.withdrawLeafIndex!]
            const aToken = `0x${withdrawLeaf.data.slice(2, 42)}` as Address
            const publicClient = createPublicClient({ chain: celo, transport: http(env.RPC_URL) })
            const withdrawAmount = await publicClient.readContract({
              address: aToken,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [order.signer as Address],
            })
            // Quote with 99.9% of balance to leave dust for rounding differences
            const quoteAmount = withdrawAmount * 999n / 1000n
            console.log(`  Withdraw amount: ${withdrawAmount} quote: ${quoteAmount} (aToken: ${aToken})`)

            // Find the conversion index in settlementData that matches this swap
            const sd = order.order.settlementData
            const numConv = parseInt(sd.slice(2, 4), 16)
            let conversionIndex = 0
            for (let ci = 0; ci < numConv; ci++) {
              const off = 4 + ci * 136
              const cIn = ('0x' + sd.slice(off, off + 40)).toLowerCase()
              const cOut = ('0x' + sd.slice(off + 40, off + 80)).toLowerCase()
              if (cIn === best.sourceToken.toLowerCase() && cOut === best.destToken.toLowerCase()) {
                conversionIndex = ci
                break
              }
            }
            console.log(`  Using conversion index: ${conversionIndex}`)

            const swap = await buildFillerSwap({
              assetIn: best.sourceToken,
              assetOut: best.destToken,
              amountIn: quoteAmount,
              conversionIndex,
              chainId: env.CHAIN_ID,
              slippageTolerance: 0.5,
              forwarderAddress: forwarder,
            }, { apiKey: env.UNISWAP_API_KEY })

            built = buildCollateralSwapMigration(storedOrder, best, swap, verato, account.address)
          } catch (swapErr) {
            console.log(`  Uniswap quote failed: ${swapErr instanceof Error ? swapErr.message : swapErr}`)
            // Fall back to collateral_only if available
            if (collateralOnly) {
              console.log(`  Falling back to collateral_only: ${collateralOnly.symbol} ${collateralOnly.sourceLender} → ${collateralOnly.destLender}`)
              built = buildCollateralMigration(storedOrder, collateralOnly, verato, account.address)
            } else {
              console.log(`  No fallback available — skipping`)
              built = { executionData: '0x' as Hex, fillerCalldata: '0x' as Hex }
            }
          }
        }
      }

      executionData = built.executionData
      fillerCalldata = built.fillerCalldata

      if (executionData !== '0x') {
        // Build calls: permits + pool approvals + settle with real executionData
        const calls: Hex[] = []

        for (const p of order.permits ?? []) {
          const sig = p.signature
          if (p.kind === 'ERC2612_PERMIT') {
            calls.push(encodePermit({
              token: p.targetAddress, owner: order.signer as Address, spender: verato,
              value: maxUint256, deadline: BigInt(p.deadline), v: sig.v, r: sig.r, s: sig.s,
            }))
          } else if (p.kind === 'AAVE_DELEGATION') {
            calls.push(encodeAaveDelegation({
              debtToken: p.targetAddress, delegator: order.signer as Address, delegatee: verato,
              value: maxUint256, deadline: BigInt(p.deadline), v: sig.v, r: sig.r, s: sig.s,
            }))
          } else if (p.kind === 'MORPHO_AUTHORIZATION') {
            calls.push(encodeMorphoAuthorization({
              morpho: p.targetAddress, authorizer: order.signer as Address, authorized: verato,
              isAuthorized: true, nonce: BigInt(p.nonce), deadline: BigInt(p.deadline),
              v: sig.v, r: sig.r, s: sig.s,
            }))
          }
        }

        // Approve tokens to destination pool
        const depositLeaf = order.order.leaves[best.depositLeafIndex!]
        if (depositLeaf) {
          const pool = `0x${depositLeaf.data.slice(2, 42)}` as Address
          const depositToken = best.type === 'collateral_only' ? best.token : best.destToken
          calls.push(encodeApproveToken(depositToken, pool))
        }

        // For swaps, also approve the source token to the Uniswap router (via forwarder)
        if (best.type === 'collateral_swap') {
          // The forwarder handles approvals internally, but we need to approve
          // the withdrawn token from Verato to the forwarder
          const forwarder = env.FORWARDER_ADDRESS as Address
          calls.push(encodeApproveToken(best.sourceToken, forwarder))
        }

        // Settle with our built executionData
        calls.push(encodeSettle({
          maxFeeBps: BigInt(order.order.maxFeeBps),
          solver: order.order.solver,
          minSolverReputation: BigInt(order.order.minSolverReputation),
          deadline: order.order.deadline,
          signature: order.signature,
          orderData: order.order.orderData,
          executionData,
          fillerCalldata,
        }))

        const txHash = await walletClient.writeContract({
          address: verato,
          abi: multicallAbi,
          functionName: 'multicall',
          args: [calls],
        })
        return txHash
      }
    }
  }

  // ── Debt migration (flash loan) ──────────────────────────────
  if (userSummary.hasAnyDebt && userSummary.lenders.length > 0) {
    const pools = await fetchPools(chainId)
    console.log(`  Pools: ${pools.length}`)
    const evaluation = evaluateMigrations(userSummary, pools, leafDescriptions)
    console.log(`  Debt candidates: ${evaluation.candidates.length} best: ${evaluation.bestCandidate?.type ?? 'none'}`)

    const best = evaluation.bestCandidate
    if (best && best.type === 'debt_migration' && best.improvement > 0) {
      console.log(`  Building debt migration: ${best.collateralSymbol}/${best.debtSymbol} ${best.sourceLender} → ${best.destLender} (net yield +${best.improvement.toFixed(2)}%)`)

      const storedOrder = {
        id: order.id, createdAt: 0, status: 'open' as const,
        signer: order.signer as Address, signature: order.signature,
        order: order.order, permits: order.permits ?? [],
      }

      // Read user's debt to determine flash loan amount
      const publicClient = createPublicClient({ chain: celo, transport: http(env.RPC_URL) })
      const repayLeaf = order.order.leaves[best.repayLeafIndex!]
      // repay leaf data: [1: mode][20: debtToken][20: pool]
      const vTokenAddr = `0x${repayLeaf.data.slice(4, 44)}` as Address
      const debtBalance = await publicClient.readContract({
        address: vTokenAddr,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [order.signer as Address],
      })
      // Flash loan slightly more than debt to cover accrued interest
      const flashLoanAmount = debtBalance * 1010n / 1000n

      const built = buildDebtMigration(storedOrder, best, verato, flashLoanAmount, account.address)
      executionData = built.executionData
      fillerCalldata = built.fillerCalldata
      console.log(`  Flash loan: ${flashLoanAmount} ${best.debtSymbol} (debt: ${debtBalance})`)

      // Morpho pool on Celo for flash loans
      const morphoPool = '0xd24ECdD8C1e0E57a4E26B1a7bbeAa3e95466A569' as Address

      // Build calls: permits + approvals + settleWithFlashLoan
      const calls: Hex[] = []

      for (const p of order.permits ?? []) {
        const sig = p.signature
        if (p.kind === 'ERC2612_PERMIT') {
          calls.push(encodePermit({
            token: p.targetAddress, owner: order.signer as Address, spender: verato,
            value: maxUint256, deadline: BigInt(p.deadline), v: sig.v, r: sig.r, s: sig.s,
          }))
        } else if (p.kind === 'AAVE_DELEGATION') {
          calls.push(encodeAaveDelegation({
            debtToken: p.targetAddress, delegator: order.signer as Address, delegatee: verato,
            value: maxUint256, deadline: BigInt(p.deadline), v: sig.v, r: sig.r, s: sig.s,
          }))
        } else if (p.kind === 'MORPHO_AUTHORIZATION') {
          calls.push(encodeMorphoAuthorization({
            morpho: p.targetAddress, authorizer: order.signer as Address, authorized: verato,
            isAuthorized: true, nonce: BigInt(p.nonce), deadline: BigInt(p.deadline),
            v: sig.v, r: sig.r, s: sig.s,
          }))
        }
      }

      // Approve collateral to dest pool (for deposit)
      const depositLeaf = order.order.leaves[best.depositLeafIndex!]
      const destPool = `0x${depositLeaf.data.slice(2, 42)}` as Address
      calls.push(encodeApproveToken(best.collateralToken, destPool))
      // Approve debt token to source pool (for repay)
      // repay leaf data: [1: mode][20: debtToken][20: pool] — pool at bytes 21-40
      const repayPool = `0x${repayLeaf.data.slice(44, 84)}` as Address
      calls.push(encodeApproveToken(best.debtToken, repayPool))
      // Approve debt token to Morpho (for flash loan repayment)
      calls.push(encodeApproveToken(best.debtToken, morphoPool))

      // settleWithFlashLoan
      calls.push(encodeSettleWithFlashLoan({
        flashLoanAsset: best.debtToken,
        flashLoanAmount,
        flashLoanPool: morphoPool,
        poolId: 0, // Morpho
        maxFeeBps: BigInt(order.order.maxFeeBps),
        solver: order.order.solver,
        minSolverReputation: BigInt(order.order.minSolverReputation),
        deadline: order.order.deadline,
        signature: order.signature,
        orderData: order.order.orderData,
        executionData,
        fillerCalldata,
      }))

      const txHash = await walletClient.writeContract({
        address: verato,
        abi: multicallAbi,
        functionName: 'multicall',
        args: [calls],
      })
      return txHash
    }
  }

  // Fallback: use the order's raw data (permits + approvals + settle)
  const calls = buildMulticallData(env, order, fillerCalldata)

  if (calls.length === 1) {
    const txHash = await walletClient.writeContract({
      address: verato,
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
    address: verato,
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

    // POST /run-direct — run the full direct settlement flow (positions + LLM + execute)
    if (url.pathname === '/run-direct' && request.method === 'POST') {
      try {
        const chainId = parseInt(env.CHAIN_ID)
        initWallet(env.PRIVATE_KEY, chainId)
        setProviderKeys(env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY)
        const results = await runAllSettlements(chainId, env.ORDERS_API_URL)
        return Response.json({ processed: results.length, results })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return Response.json({ error: msg }, { status: 500 })
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  },
} satisfies ExportedHandler<Env>
