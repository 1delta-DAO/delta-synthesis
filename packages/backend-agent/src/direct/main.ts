/**
 * Settlement orchestration — direct version (no MCP).
 *
 * Same flow as ../main.ts but uses:
 *   - direct/api.ts for 1delta data
 *   - direct/wallet.ts for WDK wallet operations
 *   - direct/agent.ts for a simple function-based tool router
 */

import type { Address } from 'viem'
import { CONTRACTS_BY_CHAIN } from '../config/index.js'
import { buildDebtMigrationPrompt, buildFlatOptions } from '../prompt/index.js'
import { runAgentLoop, createRouter } from './agent.js'
import type { ToolHandler } from './agent.js'
import { fetchOrder, fetchOpenOrders, markOrderFilled, describeLeaves } from '../order.js'
import type { MerkleLeaf } from '../order.js'
import { fetchUserPositions } from './api.js'
import type { LenderPositions } from './api.js'
import { buildSettlementContext } from './context.js'
import { executeSettlement } from './settle.js'
import { getWalletAddress } from './wallet.js'
import { interpretPositions, fetchPools, evaluateMigrations } from '../interpret/index.js'

/** Tool schema for the agent loop. */
interface GenericTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Full settlement flow for a single order — direct version.
 *
 *   1. Fetch StoredOrder from order backend
 *   2. Decode all leaves
 *   3. Direct API: fetch positions + rates → SettlementContext
 *   4. Agent receives structured options and calls propose_migration
 *   5. Direct wallet: build executionData and submit tx
 */
export async function runSettlementFlow(
  orderId: string,
  chainId: number,
  ordersApiUrl: string,
): Promise<string> {
  const chainContracts = CONTRACTS_BY_CHAIN[chainId]
  const settlement = chainContracts.settlement
  const morphoPool = chainContracts.morphoPool
  if (!settlement) throw new Error('SETTLEMENT CONTRACT ADDRESS is required')
  if (!morphoPool) throw new Error('MORPHO POOL ADDRESS is required')

  // ── Fetch order ──────────────────────────────────────────
  console.log(`\nFetching order ${orderId}…`)
  const order = await fetchOrder(ordersApiUrl, orderId)
  console.log(`  signer: ${order.signer}  leaves: ${order.order.leaves.length}  status: ${order.status}`)

  if (order.status !== 'open') throw new Error(`Order ${orderId} is ${order.status}`)

  const leaves = order.order.leaves
  const leafDescriptions = describeLeaves(leaves)

  console.log('\nLeaves:')
  leafDescriptions.forEach(l => {
    const extra = l.pool ? `pool=${l.pool.slice(0, 10)}…`
      : l.loanToken ? `loan=${l.loanToken.slice(0, 10)}… coll=${l.collateralToken?.slice(0, 10)}… lltv=${l.lltv}`
      : ''
    console.log(`  [${l.index}] ${l.op} ${l.protocol} ${extra}`)
  })

  // ── Fetch positions & branch on debt ──────────────────────
  console.log('\nFetching user positions…')
  const rawPositions = await fetchUserPositions(order.signer, chainId) as unknown as LenderPositions[]
  const userSummary = interpretPositions(order.signer, String(chainId), rawPositions)

  console.log(`  Lenders: ${userSummary.lenders.length}  Debt: $${userSummary.totalDebtUsd.toFixed(2)}  Deposits: $${userSummary.totalDepositsUsd.toFixed(2)}`)

  if (!userSummary.hasAnyDebt) {
    // ── Simple collateral migration (no flash loan) ──────────
    console.log('\nNo debt detected — evaluating collateral-only migrations…')
    const pools = await fetchPools(chainId)
    const evaluation = evaluateMigrations(userSummary, pools, leafDescriptions)

    if (!evaluation.bestCandidate) {
      console.log('  No profitable collateral migration found.')
      return 'SKIPPED_NO_IMPROVEMENT'
    }

    const best = evaluation.bestCandidate
    if (best.type === 'collateral_only') {
      console.log(`  Best: ${best.symbol} from ${best.sourceLender} → ${best.destLender} (+${best.improvement.toFixed(4)}% APY)`)
      console.log(`    withdraw leaf: ${best.withdrawLeafIndex}  deposit leaf: ${best.depositLeafIndex}`)
      // TODO: build and submit the simple withdraw+deposit settlement tx
      // For now, log the decision
      return `COLLATERAL_MIGRATION: ${best.symbol} ${best.sourceLender} → ${best.destLender} improvement=${best.improvement.toFixed(4)}%`
    }
  }

  // ── Debt path: full migration flow ─────────────────────────
  console.log('\nDebt detected — running full migration flow…')
  const ctx = await buildSettlementContext(order, chainId, leafDescriptions)

  if (!ctx) {
    console.log('No viable settlement context — skipping order.')
    return 'SKIPPED_NO_CONTEXT'
  }

  if (ctx.options.every((o: { destinations: unknown[] }) => o.destinations.length === 0)) {
    console.log('No destination options available — skipping order.')
    return 'SKIPPED_NO_DESTINATIONS'
  }

  // ── Wallet address (direct) ────────────────────────────
  let walletAddress = ''
  try {
    walletAddress = await getWalletAddress(chainId)
  } catch (err) {
    console.warn('Could not fetch wallet address:', err instanceof Error ? err.message : err)
  }

  // ── Flat option list ───────────────────────────────────
  const flatOptions = buildFlatOptions(ctx)

  // ── propose_migration local tool ───────────────────────
  interface MigrationDecision {
    sourceRepayLeafIndex: number
    sourceWithdrawLeafIndex: number
    destDepositLeafIndex: number
    destBorrowLeafIndex: number
    collateralAsset: Address
    debtAsset: Address
    debtAmountBaseUnits: string
    reason: string
  }
  let migrationDecision: MigrationDecision | null = null

  const proposeMigration: ToolHandler = async (input) => {
    const optIdx = Number(input.optionIndex)
    const chosen = flatOptions[optIdx]
    if (!chosen) {
      return `Invalid optionIndex ${optIdx}. Valid range: 0–${flatOptions.length - 1}.`
    }
    migrationDecision = {
      sourceRepayLeafIndex: chosen.source.group.repayLeafIndex!,
      sourceWithdrawLeafIndex: chosen.source.group.withdrawLeafIndex!,
      destDepositLeafIndex: chosen.destination.group.depositLeafIndex!,
      destBorrowLeafIndex: chosen.destination.group.borrowLeafIndex!,
      collateralAsset: chosen.source.collateralToken,
      debtAsset: chosen.source.debtToken,
      debtAmountBaseUnits: chosen.source.debtAmountBaseUnits,
      reason: String(input.reason),
    }
    console.log('\n→ Agent proposed migration:', migrationDecision.reason)
    return 'Migration proposal recorded. Proceeding to build and submit settlement transaction.'
  }

  const proposeMigrationTool: GenericTool = {
    name: 'propose_migration',
    description: 'Submit the chosen migration option by its index. Call this exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        optionIndex: { type: 'number', description: 'The index of the chosen OPTION from the list (0, 1, 2, …)' },
        reason: { type: 'string', description: 'One-line explanation naming the protocols and improvement value' },
      },
      required: ['optionIndex', 'reason'],
    },
  }

  // ── Run agent ──────────────────────────────────────────
  const allTools: GenericTool[] = [proposeMigrationTool]
  const systemPrompt = buildDebtMigrationPrompt(walletAddress, ctx, flatOptions)
  const userMessage = `Analyze the pre-computed settlement context for order ${orderId} on chain ${chainId} and execute the best migration.`

  const router = createRouter({ propose_migration: proposeMigration })
  const resultText = await runAgentLoop(router, systemPrompt, allTools, userMessage)

  console.log('\n=== Agent Result ===')
  console.log(resultText)

  // ── Execute settlement (direct wallet) ─────────────────
  if (!migrationDecision) {
    console.log('\nAgent did not propose a migration — no action taken.')
    return resultText
  }

  const d = migrationDecision as MigrationDecision

  const srcRepayLeaf = leaves[d.sourceRepayLeafIndex] as MerkleLeaf
  const srcWithdrawLeaf = leaves[d.sourceWithdrawLeafIndex] as MerkleLeaf
  const dstDepositLeaf = leaves[d.destDepositLeafIndex] as MerkleLeaf
  const dstBorrowLeaf = leaves[d.destBorrowLeafIndex] as MerkleLeaf

  console.log('\n=== Leaves selected ===')
  console.log(`  sourceRepay   [${d.sourceRepayLeafIndex}]: lender=${srcRepayLeaf?.lenderId}  proofLen=${srcRepayLeaf?.proof?.length ?? 0}  data=${String(srcRepayLeaf?.data).slice(0, 20)}…`)
  console.log(`  sourceWithdraw[${d.sourceWithdrawLeafIndex}]: lender=${srcWithdrawLeaf?.lenderId}  proofLen=${srcWithdrawLeaf?.proof?.length ?? 0}  data=${String(srcWithdrawLeaf?.data).slice(0, 20)}…`)
  console.log(`  destDeposit   [${d.destDepositLeafIndex}]: lender=${dstDepositLeaf?.lenderId}  proofLen=${dstDepositLeaf?.proof?.length ?? 0}  data=${String(dstDepositLeaf?.data).slice(0, 20)}…`)
  console.log(`  destBorrow    [${d.destBorrowLeafIndex}]: lender=${dstBorrowLeaf?.lenderId}  proofLen=${dstBorrowLeaf?.proof?.length ?? 0}  data=${String(dstBorrowLeaf?.data).slice(0, 20)}…`)

  const txHash = await executeSettlement({
    order,
    sourceRepayLeaf: srcRepayLeaf,
    sourceWithdrawLeaf: srcWithdrawLeaf,
    destDepositLeaf: dstDepositLeaf,
    destBorrowLeaf: dstBorrowLeaf,
    collateralAsset: d.collateralAsset,
    debtAsset: d.debtAsset,
    user: order.signer,
    settlement,
    morphoPool,
    debtAmount: BigInt(d.debtAmountBaseUnits),
    feeRecipient: walletAddress as Address || undefined,
  })

  if (txHash !== 'DRY_RUN' && txHash !== 'SKIPPED_NOT_ECONOMIC') {
    await markOrderFilled(ordersApiUrl, orderId, txHash)
    console.log(`  Order ${orderId} marked as filled.`)
  }

  return txHash
}

/**
 * Fetches all open orders for a chain and runs the settlement flow on each.
 */
export async function runAllSettlements(
  chainId: number,
  ordersApiUrl?: string,
): Promise<{ orderId: string; result: string }[]> {
  const apiUrl = ordersApiUrl ?? 'http://localhost:8787'
  console.log(`\nFetching open orders for chain ${chainId}…`)
  const orders = await fetchOpenOrders(apiUrl, chainId)
  console.log(`  Found ${orders.length} open order(s).`)

  const results: { orderId: string; result: string }[] = []

  for (const order of orders) {
    console.log(`\n─── Processing order ${order.id} ───`)
    try {
      const result = await runSettlementFlow(order.id, chainId, apiUrl)
      results.push({ orderId: order.id, result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  Error processing order ${order.id}: ${msg}`)
      results.push({ orderId: order.id, result: `ERROR: ${msg}` })
    }
  }

  return results
}
