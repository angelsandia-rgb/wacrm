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
 * Hotel "a teammate is here" signal (owner, 2026-10-07): once a teammate
 * has replied in a conversation, follow-up nudges stop and the AI keeps
 * assisting but is told not to offer to connect the guest with the team
 * (it used to, while one was already chatting). Cleared by "Reanudar IA"
 * (writes a note with this prefix) or "Reiniciar IA" (moves
 * `ai_context_reset_at`).
 */
export const AI_RESUMED_NOTE_PREFIX = '▶️'

/** WhatsApp Business app greeting / away messages are echoed as `agent`
 *  rows (Coexistence) seconds after the customer writes; a person takes
 *  longer. Anything faster than this is treated as automatic. */
const AUTO_REPLY_MAX_MS = 15_000

/** Pure: given customer + agent rows oldest-first, did a real teammate
 *  answer the customer? Agent rows before the customer's first message
 *  (a campaign or template the team started with) don't count. */
export function hasTeammateReply(rows: { sender_type: string; created_at: string }[]): boolean {
  let lastCustomerAt: number | null = null
  for (const r of rows) {
    const at = Date.parse(r.created_at)
    if (r.sender_type === 'customer') lastCustomerAt = at
    else if (r.sender_type === 'agent' && lastCustomerAt !== null && at - lastCustomerAt > AUTO_REPLY_MAX_MS) return true
  }
  return false
}

/** Has a teammate taken this conversation over since the AI was last
 *  reset (`resetAtISO`) or reactivated? */
export async function teammateTookOver(
  db: SupabaseClient,
  conversationId: string,
  resetAtISO: string | null,
): Promise<boolean> {
  const { data: resumed } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'internal_note')
    .like('content_text', `${AI_RESUMED_NOTE_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(1)
  const since = [resetAtISO, (resumed?.[0]?.created_at as string | undefined) ?? null]
    .filter((s): s is string => !!s)
    .sort()
    .pop()

  let q = db
    .from('messages')
    .select('sender_type, created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['customer', 'agent'])
    .neq('content_type', 'internal_note')
  if (since) q = q.gt('created_at', since)
  // ponytail: newest 500 rows is plenty for a WhatsApp thread; page if one ever outgrows it.
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500)
  if (error) throw error
  return hasTeammateReply((data ?? []).reverse())
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
