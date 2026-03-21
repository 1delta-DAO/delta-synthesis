/**
 * Prompt for collateral-only migration — no debt, no flash loans.
 */

import { DRY_RUN } from '../config/index.js'
import type { MigrationCandidate } from '../interpret/index.js'
import type { UserSummary } from '../interpret/index.js'

export function buildCollateralMigrationPrompt(
  walletAddress: string,
  chainId: number,
  orderSigner: string,
  userSummary: UserSummary,
  candidates: MigrationCandidate[],
): string {
  const dryRunNote = DRY_RUN
    ? '\nDRY RUN MODE: Do NOT call propose_collateral_migration. Only report what you would do.'
    : ''

  const positionLines = userSummary.lenders
    .map(l => {
      const deps = l.deposits.map(d => `${d.symbol}: $${d.amountUsd.toFixed(2)}`).join(', ')
      return `  ${l.protocol}: deposits=[${deps}]  health=${l.healthFactor > 100 ? '∞' : l.healthFactor.toFixed(2)}`
    })
    .join('\n')

  const optionLines = candidates.map((c, i) => {
    if (c.type === 'collateral_only') {
      return [
        `OPTION [${i}]: ${c.symbol} FROM ${c.sourceLender} → TO ${c.destLender}`,
        `  amount: $${c.amountUsd.toFixed(2)}`,
        `  source APY: ${c.sourceDepositRate.toFixed(4)}%  dest APY: ${c.destDepositRate.toFixed(4)}%`,
        `  improvement: +${c.improvement.toFixed(4)}%`,
        `  withdraw leaf: ${c.withdrawLeafIndex ?? 'N/A'}  deposit leaf: ${c.depositLeafIndex ?? 'N/A'}`,
      ].join('\n')
    }
    if (c.type === 'collateral_swap') {
      return [
        `OPTION [${i}]: SWAP ${c.sourceSymbol} → ${c.destSymbol}  FROM ${c.sourceLender} → TO ${c.destLender}`,
        `  amount: $${c.amountUsd.toFixed(2)}  (requires Uniswap swap)`,
        `  source APY (${c.sourceSymbol}): ${c.sourceDepositRate.toFixed(4)}%  dest APY (${c.destSymbol}): ${c.destDepositRate.toFixed(4)}%`,
        `  improvement: +${c.improvement.toFixed(4)}%`,
        `  withdraw leaf: ${c.withdrawLeafIndex ?? 'N/A'}  deposit leaf: ${c.depositLeafIndex ?? 'N/A'}`,
      ].join('\n')
    }
    // debt_migration shouldn't appear here but handle gracefully
    return `OPTION [${i}]: ${c.type} ${c.sourceLender} → ${c.destLender} (improvement: ${c.improvement?.toFixed(4) ?? 'N/A'}%)`
  }).join('\n\n')

  return `You are an AI settlement agent performing collateral migrations on Celo.
The user has NO active debt — this is a deposit rate optimization.
No flash loans are needed.

Two flows are possible:
- SAME-TOKEN: withdraw token X from lender A → deposit token X to lender B
- CROSS-ASSET SWAP: withdraw token X from lender A → swap X→Y via Uniswap → deposit token Y to lender B
Options marked "requires Uniswap swap" use the swap flow. Prefer same-token when improvement is comparable.

CHAIN: ${chainId}
WALLET: ${walletAddress || 'UNKNOWN'}
ORDER SIGNER: ${orderSigner}

CURRENT POSITIONS:
${positionLines}

MIGRATION OPTIONS:
${optionLines}

OPTIMIZATION GOAL:
Pick the option with the highest APY improvement.
Only migrate if the improvement is meaningful (> 0.01%).

If a good option exists, call propose_collateral_migration with that option's index.
If no option is worthwhile, do NOT call propose_collateral_migration.

RULES:
- Pass the exact optionIndex from the list above.
- reason: one-line explanation naming the token, protocols, and APY improvement.${dryRunNote}`
}
