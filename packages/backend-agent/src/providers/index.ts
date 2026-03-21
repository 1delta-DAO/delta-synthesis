/**
 * LLM provider abstraction — calls Anthropic or OpenAI for the agent loop.
 */

import type { ToolRouter } from '../direct/agent.js'

export interface GenericTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface Provider {
  runAgentLoop(
    router: ToolRouter,
    systemPrompt: string,
    tools: GenericTool[],
    userMessage: string,
  ): Promise<string>
}

/**
 * Create an LLM provider using env vars.
 * Prefers ANTHROPIC_API_KEY, falls back to OPENAI_API_KEY.
 */
export function createProvider(): Provider {
  return {
    async runAgentLoop(router, systemPrompt, tools, userMessage) {
      // Determine which API to use
      const anthropicKey = (globalThis as any).__ANTHROPIC_API_KEY as string | undefined
      const openaiKey = (globalThis as any).__OPENAI_API_KEY as string | undefined

      const toolDescriptions = tools.map(t => `- ${t.name}: ${t.description}`).join('\n')
      const prompt = `${systemPrompt}\n\nAvailable tools:\n${toolDescriptions}\n\nUser: ${userMessage}`

      if (anthropicKey) {
        return callAnthropic(anthropicKey, prompt, tools, router)
      }
      if (openaiKey) {
        return callOpenAI(openaiKey, prompt, tools, router)
      }

      throw new Error('No LLM API key configured. Set __ANTHROPIC_API_KEY or __OPENAI_API_KEY on globalThis.')
    },
  }
}

/** Set API keys so the provider can find them (call from worker entry). */
export function setProviderKeys(anthropicKey?: string, openaiKey?: string) {
  if (anthropicKey) (globalThis as any).__ANTHROPIC_API_KEY = anthropicKey
  if (openaiKey) (globalThis as any).__OPENAI_API_KEY = openaiKey
}

async function callAnthropic(
  apiKey: string,
  prompt: string,
  tools: GenericTool[],
  router: ToolRouter,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`)
  const result = await res.json() as {
    content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string }>
  }

  // Process tool calls
  for (const block of result.content) {
    if (block.type === 'tool_use' && block.name && block.input) {
      const toolResult = await router(block.name, block.input)
      return toolResult
    }
    if (block.type === 'text' && block.text) {
      return block.text
    }
  }

  return 'No response from agent'
}

async function callOpenAI(
  apiKey: string,
  prompt: string,
  tools: GenericTool[],
  router: ToolRouter,
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1024,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      })),
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`)
  const result = await res.json() as {
    choices: Array<{
      message: {
        content?: string
        tool_calls?: Array<{ function: { name: string; arguments: string } }>
      }
    }>
  }

  const msg = result.choices[0]?.message
  if (msg?.tool_calls?.[0]) {
    const call = msg.tool_calls[0]
    const input = JSON.parse(call.function.arguments)
    return router(call.function.name, input)
  }

  return msg?.content ?? 'No response from agent'
}
