/**
 * Agent loop with a simple function-based tool router — no MCP.
 *
 * The router is just a Record<string, handler> instead of an MCP ToolRouter.
 */

import { createProvider } from '../providers/index.js'
import type { GenericTool } from '../providers/index.js'

export type ToolHandler = (input: Record<string, unknown>) => Promise<string>
export type ToolRouter = (toolName: string, input: Record<string, unknown>) => Promise<string>

/** Build a simple router from a map of tool name → handler function. */
export function createRouter(handlers: Record<string, ToolHandler>): ToolRouter {
  return async (toolName, input) => {
    const handler = handlers[toolName]
    if (!handler) throw new Error(`Unknown tool: ${toolName}`)
    return handler(input)
  }
}

export async function runAgentLoop(
  router: ToolRouter,
  systemPrompt: string,
  tools: GenericTool[],
  userMessage: string,
): Promise<string> {
  const provider = createProvider()
  return provider.runAgentLoop(router, systemPrompt, tools, userMessage)
}
