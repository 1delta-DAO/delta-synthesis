/**
 * Direct mode — settlement agent without MCP.
 *
 * Drop-in replacement for the MCP-based flow. Uses:
 *   - Direct HTTP calls to the 1delta API (positions, markets)
 *   - Direct WDK wallet for signing and sending transactions
 *   - Simple function-based tool router for the agent loop
 *
 * Usage:
 *   import { runAllSettlements, runSettlementFlow } from './direct/index.js'
 *   await runAllSettlements(42161)
 */

export { runAllSettlements, runSettlementFlow } from './main.js'
export { initWallet, getWalletAddress, sendTransaction } from './wallet.js'
export { fetchUserPositions, fetchLendingMarkets } from './api.js'
export { buildSettlementContext } from './context.js'
export { executeSettlement } from './settle.js'
export { runAgentLoop, createRouter } from './agent.js'
export type { ToolHandler, ToolRouter } from './agent.js'
