import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiUsage, ChatMessage } from '@/lib/ai/types'
import { runAssistantTurnAnthropic } from './anthropic-tools'
import { runAssistantTurnOpenAi } from './openai-tools'

// ============================================================
// Provider-agnostic entry point for the owner-only assistant chat
// (`POST /api/ai/assistant`). The tool-calling loop itself is
// provider-specific (Anthropic and OpenAI describe tools, tool calls
// and tool results with different message shapes), so each lives in its
// own module; this file just picks one by `provider`.
// ============================================================

/** One proposed write action the model wants to take. Never executed by
 *  the loop — the caller (route.ts) hands it to the frontend, which must
 *  get the owner's explicit confirmation before anything runs. */
export interface PendingAction {
  action: string
  input: Record<string, unknown>
}

export interface AssistantTurnResult {
  reply: string
  pendingAction: PendingAction | null
  usage: AiUsage | null
}

export interface RunAssistantTurnArgs {
  provider: 'anthropic' | 'openai'
  db: SupabaseClient
  accountId: string
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
}

/**
 * Run one owner turn of the assistant to completion against the
 * account's configured provider: sends the tool catalog, executes every
 * READ tool the model asks for immediately (server-side, RLS-scoped to
 * `accountId`), and feeds results back — bounded by `MAX_TOOL_ROUNDS`.
 * The moment the model calls a WRITE tool the loop stops without
 * executing it and returns it as `pendingAction`; nothing is ever
 * mutated here.
 */
export async function runAssistantTurn(
  args: RunAssistantTurnArgs,
): Promise<AssistantTurnResult> {
  const { provider, ...rest } = args
  return provider === 'openai'
    ? runAssistantTurnOpenAi(rest)
    : runAssistantTurnAnthropic(rest)
}
