/**
 * Live test — evaluate migration for a real address on Celo.
 *
 * Address: 0x00000F095Bee93CECE622Fb8FdB90B2D2F4Cc6ff
 * Has CELO deposited in Moola. User only permitted CELO operations.
 *
 * Run: npx tsx test/live-evaluate.test.ts
 */

import { fetchUserPositions } from '../src/direct/api.js'
import { fetchPools } from '../src/interpret/pools.js'
import { interpretPositions } from '../src/interpret/positions.js'
import { evaluateMigrations } from '../src/interpret/evaluate.js'
import type { LeafDescription } from '../src/order.js'
import type { LenderPositions } from '../src/direct/api.js'

const ACCOUNT = '0x00000F095Bee93CECE622Fb8FdB90B2D2F4Cc6ff'
const CHAIN_ID = 42220

// User only permitted CELO — withdraw from Moola, deposit to Aave V3
const PERMITTED_LEAVES: LeafDescription[] = [
  // WITHDRAW CELO from Moola (lenderId 1000 = AAVE_V2 range, used by Moola)
  { index: 0, op: 'WITHDRAW', protocol: 'AAVE_V2', lenderId: 1000, pool: '0x970b12522CA9b4054807a2c5B736149a5BE6f670' },
  // DEPOSIT CELO to Aave V3 (lenderId 0)
  { index: 1, op: 'DEPOSIT', protocol: 'AAVE_V3', lenderId: 0, pool: '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402' },
]

async function main() {
  console.log(`\nFetching positions for ${ACCOUNT} on Celo…`)
  const rawPositions = await fetchUserPositions(ACCOUNT, CHAIN_ID)
  const lenderPositions = rawPositions as unknown as LenderPositions[]

  const userSummary = interpretPositions(ACCOUNT, String(CHAIN_ID), lenderPositions)

  console.log(`\nUser summary:`)
  console.log(`  hasAnyDebt: ${userSummary.hasAnyDebt}`)
  console.log(`  totalDepositsUsd: $${userSummary.totalDepositsUsd.toFixed(2)}`)
  console.log(`  totalDebtUsd: $${userSummary.totalDebtUsd.toFixed(2)}`)
  for (const l of userSummary.lenders) {
    console.log(`\n  ${l.protocol}:`)
    console.log(`    health: ${l.healthFactor == null || l.healthFactor > 100 ? '∞' : l.healthFactor.toFixed(2)}`)
    console.log(`    deposits: $${l.totalDepositsUsd.toFixed(2)}`)
    console.log(`    debt: $${l.totalDebtUsd.toFixed(2)}`)
    for (const d of l.deposits) {
      console.log(`    deposit: ${d.symbol} $${d.amountUsd.toFixed(2)}`)
    }
    for (const d of l.debts) {
      console.log(`    debt: ${d.symbol} $${d.amountUsd.toFixed(2)}`)
    }
  }

  console.log(`\nFetching pools on Celo…`)
  const pools = await fetchPools(CHAIN_ID)
  console.log(`  ${pools.length} active pools`)

  // Show relevant pool rates
  const celoAddr = '0x471ece3750da237f93b8e339c536989b8978a438'
  const celoPools = pools.filter(p => p.token.toLowerCase() === celoAddr.toLowerCase())
  console.log(`\n  CELO pools:`)
  for (const p of celoPools) {
    console.log(`    ${p.lenderKey}: deposit=${p.depositRate.toFixed(4)}% borrow=${p.variableBorrowRate.toFixed(4)}% liquidity=$${p.totalLiquidityUsd.toFixed(0)}`)
  }

  console.log(`\nEvaluating migrations (CELO-only permissions)…`)
  const evaluation = evaluateMigrations(userSummary, pools, PERMITTED_LEAVES)

  console.log(`\n  hasDebt: ${evaluation.hasDebt}`)
  console.log(`  candidates: ${evaluation.candidates.length}`)

  for (const [i, c] of evaluation.candidates.entries()) {
    if (c.type === 'collateral_only') {
      console.log(`\n  [${i}] SAME-TOKEN: ${c.symbol} ${c.sourceLender} → ${c.destLender}`)
      console.log(`      APY: ${c.sourceDepositRate.toFixed(4)}% → ${c.destDepositRate.toFixed(4)}%  improvement: +${c.improvement.toFixed(4)}%`)
      console.log(`      amount: $${c.amountUsd.toFixed(2)}`)
      console.log(`      withdraw leaf: ${c.withdrawLeafIndex}  deposit leaf: ${c.depositLeafIndex}`)
    } else if (c.type === 'collateral_swap') {
      console.log(`\n  [${i}] SWAP: ${c.sourceSymbol} → ${c.destSymbol}  ${c.sourceLender} → ${c.destLender}`)
      console.log(`      APY: ${c.sourceDepositRate.toFixed(4)}% → ${c.destDepositRate.toFixed(4)}%  improvement: +${c.improvement.toFixed(4)}%`)
      console.log(`      amount: $${c.amountUsd.toFixed(2)}`)
    }
  }

  if (evaluation.bestCandidate) {
    console.log(`\n  ✓ BEST MIGRATION:`)
    const best = evaluation.bestCandidate
    if (best.type === 'collateral_only') {
      console.log(`    ${best.symbol}: ${best.sourceLender} → ${best.destLender}`)
      console.log(`    APY improvement: +${best.improvement.toFixed(4)}%`)
      console.log(`    Flow: withdraw CELO from Moola → deposit CELO to Aave V3`)
      console.log(`    Flash loan needed: NO`)
    } else if (best.type === 'collateral_swap') {
      console.log(`    ${best.sourceSymbol} → ${best.destSymbol}: ${best.sourceLender} → ${best.destLender}`)
      console.log(`    APY improvement: +${best.improvement.toFixed(4)}%`)
      console.log(`    Flow: withdraw ${best.sourceSymbol} from ${best.sourceLender} → swap via Uniswap → deposit ${best.destSymbol} to ${best.destLender}`)
    }
  } else {
    console.log(`\n  ✗ No viable migration found for CELO-only permissions`)
  }
}

main().catch(console.error)
