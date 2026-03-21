/**
 * Prompt for debt migration — full flash loan flow.
 */

import { DRY_RUN } from '../config/index.js'
import type { SettlementContext, SourceInfo, DestinationInfo } from '../context.js'

export interface FlatOption {
  index: number
  source: SourceInfo
  destination: DestinationInfo
}

/** Flatten ctx.options into all (source, dest) pairs for unambiguous agent selection. */
export function buildFlatOptions(ctx: SettlementContext): FlatOption[] {
  const flat: FlatOption[] = []
  for (const opt of ctx.options) {
    for (const dest of opt.destinations) {
      flat.push({ index: flat.length, source: opt.source, destination: dest })
    }
  }
  return flat
}

export function buildDebtMigrationPrompt(
  walletAddress: string,
  ctx: SettlementContext,
  flat: FlatOption[],
): string {
  const dryRunNote = DRY_RUN
    ? '\nDRY RUN MODE: Do NOT call propose_migration. Only report what you would do.'
    : ''

  const optionLines = flat.map(o => {
    const imp = o.destination.improvement !== null
      ? (o.destination.improvement > 0 ? `+${o.destination.improvement.toFixed(4)}` : o.destination.improvement.toFixed(4))
      : 'N/A'
    const srcNet = o.source.rates.collateralDepositRate !== null && o.source.rates.debtBorrowRate !== null
      ? (o.source.rates.collateralDepositRate - o.source.rates.debtBorrowRate).toFixed(4)
      : 'N/A'
    const dstNet = o.destination.netYield !== null ? o.destination.netYield.toFixed(4) : 'N/A'

    return [
      `OPTION [${o.index}]: FROM ${o.source.lender} → TO ${o.destination.group.protocol}`,
      `  improvement: ${imp}  (source net: ${srcNet}  dest net: ${dstNet})`,
      `  source REPAY leaf: ${o.source.group.repayLeafIndex}  WITHDRAW leaf: ${o.source.group.withdrawLeafIndex}`,
      `  dest   DEPOSIT leaf: ${o.destination.group.depositLeafIndex}  BORROW leaf: ${o.destination.group.borrowLeafIndex}`,
      `  collateral: ${o.source.collateralToken}  debt: ${o.source.debtToken}`,
    ].join('\n')
  }).join('\n\n')

  return `You are an AI settlement agent. All market data has been pre-fetched.
Your only job: pick the best migration option and call propose_migration once with its index.

CHAIN: ${ctx.chainId}
WALLET: ${walletAddress || 'UNKNOWN'}
ORDER SIGNER: ${ctx.orderSigner}

MIGRATION OPTIONS:
${optionLines}

OPTIMIZATION GOAL:
Pick the option with the highest positive improvement value.
improvement = dest_net_yield − source_net_yield  (higher = better)

If the best improvement > 0, call propose_migration with that option's index.
If no option has improvement > 0, do NOT call propose_migration.

RULES:
- Pass the exact optionIndex from the list above.
- reason: one-line explanation naming the protocols and improvement value.${dryRunNote}`
}
