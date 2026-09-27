import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'

/**
 * "A human already answered" handling for AI auto-reply (owner's rule,
 * 2026-09-26): the bot never pauses itself any more, so when a teammate
 * replies to the customer before the bot does (the debounce window, or a
 * thread a human is actively working), the bot must first check whether
 * that human reply already covers what the customer asked. Covered →
 * stay quiet. Not covered → answer ONLY what is still missing.
 *
 * A "human" message is an outbound `sender_type = 'agent'` row — inbox
 * sends, the business's own WhatsApp app (echoes) and the public API.
 * Everything the platform sends on its own (AI replies, system lines,
 * follow-ups, reminders) is persisted as `sender_type = 'bot'`.
 */

export interface OutboundRow {
  sender_type: string
  content_type: string
  content_text: string | null
  created_at: string
}

export type TrailingState =
  /** Nothing outbound after the customer's latest message — reply normally. */
  | { kind: 'unanswered' }
  /** The bot/platform already answered it — stand down (duplicate guard). */
  | { kind: 'bot_answered' }
  /** Only humans answered it — check whether their reply covers it. */
  | { kind: 'human_answered'; humanTexts: string[] }

/**
 * Classify the outbound rows that came AFTER the customer's latest
 * message (oldest-first). Any platform row means it was already answered
 * by the bot; otherwise the human rows (with text) are what the check
 * needs to read.
 */
export function classifyTrailingOutbound(rows: OutboundRow[]): TrailingState {
  const outbound = rows.filter((r) => r.content_type !== 'internal_note' && r.sender_type !== 'customer')
  if (outbound.length === 0) return { kind: 'unanswered' }
  if (outbound.some((r) => r.sender_type === 'bot')) return { kind: 'bot_answered' }
  const humanTexts = outbound
    .map((r) => r.content_text?.trim() ?? '')
    .filter((t) => t.length > 0)
  // A human sent something without text (a photo, a document): still a
  // human answer — let the check read a placeholder rather than ignore it.
  if (humanTexts.length === 0) return { kind: 'human_answered', humanTexts: ['(El asesor envió un archivo o imagen.)'] }
  return { kind: 'human_answered', humanTexts }
}

/**
 * Read the outbound rows after the customer's latest message.
 * `sinceISO` is `conversations.ai_context_reset_at` (same bound the
 * context builder uses). Returns the customer message's timestamp too so
 * the caller can re-check for a human reply that lands mid-generation.
 */
export async function loadTrailingOutbound(
  db: SupabaseClient,
  conversationId: string,
  sinceISO: string | null,
): Promise<{ lastCustomerAt: string | null; rows: OutboundRow[] }> {
  let lastQ = db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
  if (sinceISO) lastQ = lastQ.gt('created_at', sinceISO)
  const { data: last, error: lastErr } = await lastQ
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastErr) throw lastErr
  const lastCustomerAt = (last?.created_at as string | undefined) ?? null
  if (!lastCustomerAt) return { lastCustomerAt: null, rows: [] }

  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .neq('content_type', 'internal_note')
    .gt('created_at', lastCustomerAt)
    .order('created_at', { ascending: true })
  if (error) throw error
  return { lastCustomerAt, rows: (data ?? []) as OutboundRow[] }
}

/** Count human (`agent`) outbound rows after `afterISO`. */
export async function countHumanRepliesAfter(
  db: SupabaseClient,
  conversationId: string,
  afterISO: string,
): Promise<number> {
  const { count, error } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'agent')
    .neq('content_type', 'internal_note')
    .gt('created_at', afterISO)
  if (error) throw error
  return count ?? 0
}

/**
 * Drop the trailing assistant turns (the human's reply) so the
 * transcript ends on the customer's turn again — required by Anthropic
 * and the shape every downstream step expects.
 */
export function trimTrailingAssistant(messages: ChatMessage[]): ChatMessage[] {
  let end = messages.length
  while (end > 0 && messages[end - 1].role === 'assistant') end -= 1
  return messages.slice(0, end)
}

/** The customer's consecutive trailing turns (what the human answered). */
export function trailingCustomerTurns(messages: ChatMessage[], max = 4): string[] {
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < max; i--) {
    if (messages[i].role !== 'user') break
    out.unshift(messages[i].content)
  }
  return out
}

export const HUMAN_REPLY_CHECK_PROMPT = `Eres un verificador interno de un equipo de atención por WhatsApp. No hablas con el cliente.
Recibes los últimos mensajes de un cliente y la respuesta que YA le dio un asesor humano del equipo.
Decide si la respuesta del asesor ya atiende TODO lo que el cliente preguntó o pidió en esos mensajes.
- Si ya lo atiende (aunque sea diciendo que lo revisa, que le confirma luego, o saludando cuando el cliente solo saludó), responde exactamente: CUBIERTO
- Si quedó alguna pregunta o pedido concreto sin atender, responde exactamente: PENDIENTE: <en pocas palabras, qué quedó sin atender>
No escribas nada más.`

export function buildHumanReplyCheckInput(customerTurns: string[], humanTexts: string[]): string {
  return [
    'Mensajes del cliente:',
    ...customerTurns.map((t) => `- ${t}`),
    '',
    'Respuesta del asesor humano:',
    ...humanTexts.map((t) => `- ${t}`),
  ].join('\n')
}

export type HumanReplyVerdict = { covered: true } | { covered: false; pending: string }

/**
 * Parse the checker's answer. Anything that isn't a clear PENDIENTE is
 * treated as covered: when a person is already on the thread, staying
 * quiet is the safe default (a wrong extra bot message can contradict
 * what the teammate just said).
 */
export function parseHumanReplyVerdict(raw: string): HumanReplyVerdict {
  const text = raw.trim()
  const m = /^PENDIENTE\s*:?\s*([\s\S]*)$/i.exec(text)
  if (!m) return { covered: true }
  const pending = m[1].trim()
  return { covered: false, pending: pending || 'lo que el cliente preguntó y el asesor no respondió' }
}

/** System-prompt addendum for the reply that fills the gap. */
export function humanReplyGapNote(humanTexts: string[], pending: string): string {
  return `IMPORTANTE — UN ASESOR HUMANO YA RESPONDIÓ: después del último mensaje del cliente, un asesor del equipo ya le escribió:
${humanTexts.map((t) => `«${t}»`).join('\n')}
No repitas, no resumas y no contradigas lo que dijo el asesor, y no vuelvas a saludar. Responde SOLO lo que quedó pendiente: ${pending}. Sé breve.`
}
