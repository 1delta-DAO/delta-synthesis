/**
 * Test the migration evaluator with mock positions and pools.
 *
 * Run: npx tsx test/evaluate.test.ts
 */

import { interpretPositions } from '../src/interpret/positions.js'
import { evaluateMigrations } from '../src/interpret/evaluate.js'
import {
  SCENARIO_NO_DEBT,
  SCENARIO_WITH_DEBT,
  SCENARIO_SWAP,
  MOCK_POOLS,
} from './fixtures.js'

function header(name: string) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('═'.repeat(60))
}

function printCandidate(c: any, i: number) {
  if (c.type === 'collateral_only') {
    console.log(`  [${i}] SAME-TOKEN: ${c.symbol} ${c.sourceLender} → ${c.destLender}`)
    console.log(`      APY: ${c.sourceDepositRate.toFixed(4)}% → ${c.destDepositRate.toFixed(4)}%  improvement: +${c.improvement.toFixed(4)}%`)
    console.log(`      amount: $${c.amountUsd.toFixed(2)}  withdraw leaf: ${c.withdrawLeafIndex}  deposit leaf: ${c.depositLeafIndex}`)
    console.log(`      needsFlashLoan: ${c.needsFlashLoan}`)
  } else if (c.type === 'collateral_swap') {
    console.log(`  [${i}] SWAP: ${c.sourceSymbol} → ${c.destSymbol}  ${c.sourceLender} → ${c.destLender}`)
    console.log(`      APY: ${c.sourceDepositRate.toFixed(4)}% → ${c.destDepositRate.toFixed(4)}%  improvement: +${c.improvement.toFixed(4)}%`)
    console.log(`      amount: $${c.amountUsd.toFixed(2)}  withdraw leaf: ${c.withdrawLeafIndex}  deposit leaf: ${c.depositLeafIndex}`)
    console.log(`      needsSwap: ${c.needsSwap}  needsFlashLoan: ${c.needsFlashLoan}`)
  } else {
    console.log(`  [${i}] ${c.type}: ${c.sourceLender} → ${c.destLender}`)
  }
}

// ── Scenario 1: No debt — same-token migration ─────────────────────────

header('Scenario 1: No debt — cUSD from Moola (0.5%) to Aave V3 (1.2%)')

const summary1 = interpretPositions(
  '0xTestUser1111111111111111111111111111111111',
  '42220',
  SCENARIO_NO_DEBT.positions,
)

console.log(`\nUser summary:`)
console.log(`  hasAnyDebt: ${summary1.hasAnyDebt}`)
console.log(`  totalDepositsUsd: $${summary1.totalDepositsUsd.toFixed(2)}`)
console.log(`  totalDebtUsd: $${summary1.totalDebtUsd.toFixed(2)}`)
summary1.lenders.forEach(l => {
  console.log(`  ${l.protocol}: deposits=$${l.totalDepositsUsd.toFixed(2)} debt=$${l.totalDebtUsd.toFixed(2)} health=${l.healthFactor}`)
})

const eval1 = evaluateMigrations(summary1, MOCK_POOLS, SCENARIO_NO_DEBT.leaves)
console.log(`\nEvaluation:`)
console.log(`  hasDebt: ${eval1.hasDebt}`)
console.log(`  candidates: ${eval1.candidates.length}`)
eval1.candidates.forEach((c, i) => printCandidate(c, i))

if (eval1.bestCandidate) {
  console.log(`\n  ✓ Best candidate:`)
  printCandidate(eval1.bestCandidate, 0)
} else {
  console.log(`\n  ✗ No viable migration found`)
}

// ── Scenario 2: With debt — should flag debt path ───────────────────────

header('Scenario 2: With debt — WETH collateral + USDC debt on Aave V3')

const summary2 = interpretPositions(
  '0xTestUser2222222222222222222222222222222222',
  '42220',
  SCENARIO_WITH_DEBT.positions,
)

console.log(`\nUser summary:`)
console.log(`  hasAnyDebt: ${summary2.hasAnyDebt}`)
console.log(`  totalDepositsUsd: $${summary2.totalDepositsUsd.toFixed(2)}`)
console.log(`  totalDebtUsd: $${summary2.totalDebtUsd.toFixed(2)}`)

const eval2 = evaluateMigrations(summary2, MOCK_POOLS, SCENARIO_WITH_DEBT.leaves)
console.log(`\nEvaluation:`)
console.log(`  hasDebt: ${eval2.hasDebt}`)
console.log(`  candidates: ${eval2.candidates.length} (empty = falls through to debt flow)`)

// ── Scenario 3: Cross-asset swap — CELO → USDC ─────────────────────────

header('Scenario 3: Cross-asset swap — CELO in Moola (0.1%) → USDC in Aave V3 (2.0%)')

const summary3 = interpretPositions(
  '0xTestUser3333333333333333333333333333333333',
  '42220',
  SCENARIO_SWAP.positions,
)

console.log(`\nUser summary:`)
console.log(`  hasAnyDebt: ${summary3.hasAnyDebt}`)
console.log(`  totalDepositsUsd: $${summary3.totalDepositsUsd.toFixed(2)}`)

const eval3 = evaluateMigrations(summary3, MOCK_POOLS, SCENARIO_SWAP.leaves)
console.log(`\nEvaluation:`)
console.log(`  hasDebt: ${eval3.hasDebt}`)
console.log(`  candidates: ${eval3.candidates.length}`)
eval3.candidates.forEach((c, i) => printCandidate(c, i))

if (eval3.bestCandidate) {
  console.log(`\n  ✓ Best candidate:`)
  printCandidate(eval3.bestCandidate, 0)
} else {
  console.log(`\n  ✗ No viable migration found`)
}

// ── Summary ─────────────────────────────────────────────────────────────

header('Summary')
console.log(`  Scenario 1 (no debt):    ${eval1.candidates.length} candidates, best improvement: ${eval1.bestCandidate?.improvement?.toFixed(4) ?? 'N/A'}%`)
console.log(`  Scenario 2 (with debt):  hasDebt=${eval2.hasDebt} → falls through to debt migration flow`)
console.log(`  Scenario 3 (swap):       ${eval3.candidates.length} candidates, best improvement: ${eval3.bestCandidate?.improvement?.toFixed(4) ?? 'N/A'}%`)
console.log()
