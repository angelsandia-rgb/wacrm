import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/** Shorter than this, a message is a bare acknowledgement ("sí", "ok"). */
const MIN_SUBSTANTIVE_LEN = 12

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff. Written in Spanish — this
 * app's account-facing text (unlike its next-intl UI chrome) defaults
 * to Spanish for its Guatemalan market.
 *
 * Reads as, e.g.:
 *   "🤖 La IA transfirió la conversación después de 2 respuestas.
 *    Último mensaje del cliente: “¿puedo hablar con un encargado sobre
 *    mi reembolso?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
}): string {
  const { messages, replyCount } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  const replies =
    replyCount === 0
      ? 'sin responder'
      : `después de ${replyCount} ${replyCount === 1 ? 'respuesta' : 'respuestas'}`

  const base = `🤖 La IA transfirió la conversación ${replies}.`

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  const last = `${base} Último mensaje del cliente: “${quote}”`
  // A bare "sí" / "ok" says nothing about WHY — add the customer's last
  // substantive message (test run 2026-09-24: a payment request handed
  // off with only “si” in the note).
  if (lastCustomer.content.trim().length > MIN_SUBSTANTIVE_LEN) return last
  const reason = [...messages]
    .reverse()
    .find((m) => m !== lastCustomer && m.role === 'user' && m.content.trim().length > MIN_SUBSTANTIVE_LEN)
  if (!reason) return last
  return `${last} Motivo: “${truncate(reason.content.trim(), MAX_QUOTE_LEN)}”`
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
