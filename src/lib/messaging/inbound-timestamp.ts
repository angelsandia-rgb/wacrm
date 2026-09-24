// ============================================================
// The time an inbound message really happened, from the provider's
// payload — not when our webhook ran. A burst ("hola" / "soy Fernanda" /
// "¿masaje express?") can reach us out of order, and the DB's `now()`
// default then stores them reversed (test run 2026-09-24, B50). Zernio
// stamps every event with `timestamp` when it builds it (kept across
// retries), and may carry the platform's own time on the message.
// ============================================================

/** Accepts ISO strings, epoch seconds or epoch milliseconds. */
function parseInstant(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null
  let date: Date
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const n = Number(value)
    date = new Date(n < 1e12 ? n * 1000 : n)
  } else if (typeof value === 'string') {
    date = new Date(value)
  } else {
    return null
  }
  return Number.isFinite(date.getTime()) ? date : null
}

/** Only trust a provider time close to ours — a skewed or bogus value
 *  must never push a message days away from where it belongs. */
const MAX_SKEW_MS = 15 * 60 * 1000

/**
 * ISO `created_at` for an inbound message: the first plausible candidate
 * (most precise first — the platform's own time, then the provider's
 * event time), or `undefined` to keep the DB default.
 */
export function inboundCreatedAt(candidates: unknown[], now: Date = new Date()): string | undefined {
  for (const candidate of candidates) {
    const date = parseInstant(candidate)
    if (date && Math.abs(date.getTime() - now.getTime()) <= MAX_SKEW_MS) return date.toISOString()
  }
  return undefined
}
