import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError, type AiUsage, type ChatMessage } from '@/lib/ai/types'
import { mergeConsecutive, providerHttpError, toNetworkError } from '@/lib/ai/providers/shared'
import { ASSISTANT_TOOLS, executeReadTool, isWriteTool } from './tools'
import type { AssistantTurnResult } from './run-turn'

// OpenAI implementation of the owner-assistant tool-calling loop — the
// Chat Completions "function calling" flavour. Mirrors
// `anthropic-tools.ts` one-for-one (same tool catalog, same
// read-now / propose-writes contract, same round budget); only the
// wire shapes differ.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_OUTPUT_TOKENS = 2048
const MAX_TOOL_ROUNDS = 6

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

interface OpenAiChatResponse {
  choices?: { message?: OpenAiMessage }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Chat Completions "tools" array from our provider-neutral catalog. */
const OPENAI_TOOLS = ASSISTANT_TOOLS.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))

function seedMessages(systemPrompt: string, messages: ChatMessage[]): OpenAiMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') merged.shift()
  const history: OpenAiMessage[] =
    merged.length === 0
      ? [{ role: 'user', content: '(No message yet.)' }]
      : merged.map((m) => ({ role: m.role, content: m.content }))
  return [{ role: 'system', content: systemPrompt }, ...history]
}

async function callOpenAi(args: {
  apiKey: string
  model: string
  messages: OpenAiMessage[]
  timeoutMs: number
}): Promise<OpenAiChatResponse> {
  const { apiKey, model, messages, timeoutMs } = args
  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools: OPENAI_TOOLS,
        tool_choice: 'auto',
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await providerHttpError('OpenAI', res)
  const data = (await res.json().catch(() => null)) as OpenAiChatResponse | null
  if (!data) throw new AiError('OpenAI returned an unparseable response.', { code: 'empty_response' })
  return data
}

/** Parse a tool call's JSON `arguments` string; `{}` on anything
 *  unparseable (a read tool then just gets empty input; a malformed
 *  write proposal surfaces to the owner as a near-empty action they
 *  can correct, which is safer than crashing the turn). */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function runAssistantTurnOpenAi(args: {
  db: SupabaseClient
  accountId: string
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
}): Promise<AssistantTurnResult> {
  const { db, accountId, apiKey, model, systemPrompt, messages, timeoutMs } = args

  const loop = seedMessages(systemPrompt, messages)
  let promptTokens = 0
  let completionTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const data = await callOpenAi({ apiKey, model, messages: loop, timeoutMs })
    promptTokens += data.usage?.prompt_tokens ?? 0
    completionTokens += data.usage?.completion_tokens ?? 0

    const message = data.choices?.[0]?.message
    const replyText = (message?.content ?? '').trim()
    const toolCalls = (message?.tool_calls ?? []).filter((c) => c.type === 'function')

    if (toolCalls.length === 0) {
      return { reply: replyText, pendingAction: null, usage: toUsage(promptTokens, completionTokens) }
    }

    const writeCall = toolCalls.find((c) => isWriteTool(c.function.name))
    if (writeCall) {
      return {
        reply: replyText,
        pendingAction: { action: writeCall.function.name, input: parseArgs(writeCall.function.arguments) },
        usage: toUsage(promptTokens, completionTokens),
      }
    }

    // Every call this round is a read tool — echo the assistant turn
    // (OpenAI requires the tool_calls message to precede its results),
    // run them all, then append one `tool` message per call.
    loop.push({ role: 'assistant', content: message?.content ?? null, tool_calls: toolCalls })
    for (const call of toolCalls) {
      let content: string
      try {
        const result = await executeReadTool(db, accountId, call.function.name, parseArgs(call.function.arguments))
        content = JSON.stringify(result)
      } catch (err) {
        content = `ERROR: ${err instanceof Error ? err.message : String(err)}`
      }
      loop.push({ role: 'tool', tool_call_id: call.id, content })
    }
  }

  return {
    reply: 'I looked into this but need a more specific question to finish — could you narrow it down?',
    pendingAction: null,
    usage: toUsage(promptTokens, completionTokens),
  }
}

function toUsage(promptTokens: number, completionTokens: number): AiUsage | null {
  if (promptTokens === 0 && completionTokens === 0) return null
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}
