import { fetchUserPositions } from '../src/direct/api.js'
import { fetchPools } from '../src/interpret/pools.js'
import { interpretPositions } from '../src/interpret/positions.js'
import { evaluateMigrations } from '../src/interpret/evaluate.js'
import { describeLeaves } from '../src/order.js'

async function main() {
  const res = await fetch('https://verato-orders.achim-d87.workers.dev/orders/ac40a8c7-7b84-4f6c-b02e-039211b66b74')
  const order = await res.json() as any

  const leaves = order.order.leaves.map((l: any) => ({ ...l, lenderId: l.lenderId ?? l.lender ?? 0 }))
  const leafDescs = describeLeaves(leaves)
  console.log('\nLeaf descriptions:')
  leafDescs.forEach(l => console.log(`  [${l.index}] ${l.op} ${l.protocol} lenderId=${l.lenderId}`))

  const raw = await fetchUserPositions(order.signer, 42220)
  const summary = interpretPositions(order.signer, '42220', raw as any)
  console.log(`\nUser: lenders=${summary.lenders.length}`)
  summary.lenders.forEach(l => {
    console.log(`  ${l.protocol}: deposits=${l.deposits.map(d => d.symbol + '=$' + d.amountUsd.toFixed(2)).join(', ')}`)
  })

  const pools = await fetchPools(42220)
  const celoAddr = '0x471ece3750da237f93b8e339c536989b8978a438'
  console.log('\nCELO pools:')
  pools.filter(p => p.token.toLowerCase() === celoAddr).forEach(p =>
    console.log(`  ${p.lenderKey}: rate=${p.depositRate.toFixed(4)}% collateral=${p.collateralActive}`)
  )

  const evaluation = evaluateMigrations(summary, pools, leafDescs)
  console.log(`\nCandidates: ${evaluation.candidates.length}`)
  evaluation.candidates.forEach((c, i) => {
    console.log(`  [${i}] ${c.type} ${c.sourceLender} → ${c.destLender} imp=${c.improvement?.toFixed(4)}%`)
    if (c.type === 'collateral_only') console.log(`    token=${c.symbol} withdraw=${c.withdrawLeafIndex} deposit=${c.depositLeafIndex}`)
    if (c.type === 'collateral_swap') console.log(`    ${(c as any).sourceSymbol}→${(c as any).destSymbol} withdraw=${c.withdrawLeafIndex} deposit=${c.depositLeafIndex}`)
  })
}

main().catch(console.error)
