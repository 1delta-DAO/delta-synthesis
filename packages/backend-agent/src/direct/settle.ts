/**
 * Settlement transaction builder and submitter — direct wallet version.
 *
 * Re-uses buildSettlementTx and checkEconomicViability from the parent module.
 * Replaces the WDK MCP sendTransaction call with direct wallet usage.
 */

import type { Address } from 'viem'
import { buildSettlementTx, checkEconomicViability } from '../settle.js'
import type { SettlementInput } from '../settle.js'
import { DRY_RUN, ECONOMIC_MODE, RPC_URL_BY_CHAIN, CONTRACTS_BY_CHAIN } from '../config/index.js'
import { sendTransaction } from './wallet.js'

export type { SettlementInput } from '../settle.js'

/**
 * Builds and submits the settlement transaction using the direct WDK wallet.
 * Returns the transaction hash, 'DRY_RUN', or 'SKIPPED_NOT_ECONOMIC'.
 */
export async function executeSettlement(input: SettlementInput): Promise<string> {
  const tx = buildSettlementTx(input)

  console.log('\n=== Settlement Tx ===')
  console.log(`  chainId:       ${tx.chainId}`)
  console.log(`  to:            ${tx.to}`)
  console.log(`  flashAmount:   ${tx.flashAmount}`)
  console.log(`  borrowAmount:  ${tx.borrowAmount}`)
  console.log(`  debtAsset:     ${input.debtAsset}`)
  console.log(`  collateral:    ${input.collateralAsset}`)
  console.log(`  source lender: ${input.sourceRepayLeaf.lender}`)
  console.log(`  dest lender:   ${input.destDepositLeaf.lender}`)
  console.log(`  fee recipient: ${input.feeRecipient}`)

  if (ECONOMIC_MODE) {
    const chainContracts = CONTRACTS_BY_CHAIN[input.order.order.chainId]
    const fromAddress = input.feeRecipient ?? input.user
    console.log('\n[Economic check] Estimating gas vs solver fee…')
    try {
      const rpcUrl = RPC_URL_BY_CHAIN[tx.chainId]
      if (!rpcUrl) throw new Error('RPC not found')

      const check = await checkEconomicViability(
        input,
        { to: tx.to, data: tx.data },
        tx.flashAmount,
        chainContracts.aaveOracle,
        fromAddress,
        rpcUrl,
      )
      console.log(`  ${check.reason}`)
      if (!check.viable) return 'SKIPPED_NOT_ECONOMIC'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`  Economic check failed (${msg}) — skipping to be safe`)
      return 'SKIPPED_NOT_ECONOMIC'
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Not submitting. Calldata:')
    console.log(tx.data.slice(0, 200) + '…')
    return 'DRY_RUN'
  }

  const hash = await sendTransaction(tx.chainId, { to: tx.to, data: tx.data })
  console.log('  tx hash:', hash)
  return hash
}
