// ============================================================
// CSAT — pure helpers (no I/O). Shared by the config route, the
// dispatch/capture hooks, the cron sweep, and their unit tests.
// ============================================================

export const CSAT_SCALES = [3, 5] as const
export type CsatScale = (typeof CSAT_SCALES)[number]

export const CSAT_DELAY_MIN_MINUTES = 0
/** 14 days — matches the migration's CHECK. */
export const CSAT_DELAY_MAX_MINUTES = 20_160
export const CSAT_COOLDOWN_MIN_DAYS = 0
export const CSAT_COOLDOWN_MAX_DAYS = 365

export function clampScale(v: unknown): CsatScale {
  const n = Math.floor(Number(v))
  return (CSAT_SCALES as readonly number[]).includes(n) ? (n as CsatScale) : 5
}

export function clampDelayMinutes(v: unknown): number {
  let n = Math.floor(Number(v))
  if (!Number.isFinite(n)) n = 1440
  return Math.min(CSAT_DELAY_MAX_MINUTES, Math.max(CSAT_DELAY_MIN_MINUTES, n))
}

export function clampCooldownDays(v: unknown): number {
  let n = Math.floor(Number(v))
  if (!Number.isFinite(n)) n = 30
  return Math.min(CSAT_COOLDOWN_MAX_DAYS, Math.max(CSAT_COOLDOWN_MIN_DAYS, n))
}

export interface NormalizedCsatConfig {
  moments: CsatMoments
  enabled: boolean
  template_name: string | null
  template_language: string | null
  scale: CsatScale
  delay_minutes: number
  cooldown_days: number
}

/**
 * Normalize a raw settings-form body into the columns we persist. A
 * template name is required only when `enabled` is true — an account
 * can save "off" with nothing else filled in.
 */
export function normalizeCsatConfigInput(
  body: Record<string, unknown>,
): { ok: true; value: NormalizedCsatConfig } | { ok: false; error: string } {
  const enabled = body.enabled === true
  const template_name =
    typeof body.template_name === 'string' && body.template_name.trim()
      ? body.template_name.trim()
      : null
  const template_language =
    typeof body.template_language === 'string' && body.template_language.trim()
      ? body.template_language.trim()
      : null

  const moments = normalizeMoments(body.moments)
  if (enabled && !template_name && Object.keys(moments).length === 0) {
    return { ok: false, error: 'Elige una plantilla de WhatsApp antes de activar la encuesta.' }
  }

  return {
    ok: true,
    value: {
      moments,
      enabled,
      template_name,
      template_language,
      scale: clampScale(body.scale),
      delay_minutes: clampDelayMinutes(body.delay_minutes),
      cooldown_days: clampCooldownDays(body.cooldown_days),
    },
  }
}

const CSAT_KEYWORD_RE = /(?:csat|score|rating|nps|puntaje|calificaci[oó]n)[\s_:.\-]*(\d{1,2})/i
const STANDALONE_INT_RE = /(?:^|[^\d])(\d{1,2})(?:[^\d]|$)/

/**
 * Recover the numeric rating a customer tapped from the button's
 * stable id (`interactive_reply_id`) and/or its visible label. Handles
 * bare digits ("5"), prefixed payloads ("csat_5", "rating:4"),
 * embedded digits ("5 - Excelente", "Muy bueno (4)") and star strings
 * ("★★★★★"). Returns an int in `[1, scale]`, or null when nothing
 * plausible is found.
 */
export function parseScoreFromReply(
  replyId: string | null | undefined,
  text: string | null | undefined,
  scale: number,
): number | null {
  const candidates = [replyId, text].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  )

  for (const raw of candidates) {
    const s = raw.trim()

    // 1. Exact integer.
    if (/^\d{1,2}$/.test(s)) {
      const n = Number(s)
      if (n >= 1 && n <= scale) return n
    }

    // 2. Prefixed payload: csat_5 / rating:4 / score-3.
    const kw = s.match(CSAT_KEYWORD_RE)
    if (kw) {
      const n = Number(kw[1])
      if (n >= 1 && n <= scale) return n
    }

    // 3. Star string — count the stars.
    const stars = (s.match(/[★⭐✩✪]/gu) ?? []).length
    if (stars >= 1 && stars <= scale) return stars

    // 4. First standalone 1–2 digit run anywhere in the string.
    const any = s.match(STANDALONE_INT_RE)
    if (any) {
      const n = Number(any[1])
      if (n >= 1 && n <= scale) return n
    }
  }

  return null
}

// ---------- Moments (migration 188) ----------------------------------

export const CSAT_MOMENTS = ['deal_won', 'conversation_closed', 'order_created', 'order_delivered'] as const
export type CsatMoment = (typeof CSAT_MOMENTS)[number]

export const CSAT_MOMENT_LABELS: Record<CsatMoment, string> = {
  deal_won: 'Al ganar un negocio',
  conversation_closed: 'Al cerrar la conversación',
  order_created: 'Después de la compra (Shopify)',
  order_delivered: 'Cuando el pedido se entrega (Shopify)',
}

/** Fixed waits for the moments that aren't deal_won (that one keeps
 *  delay_minutes): a close is asked right away; a purchase after an hour
 *  (it reads as service, not spam); a delivery after 3 h of use. */
export const CSAT_MOMENT_DELAY_MINUTES: Record<Exclude<CsatMoment, 'deal_won'>, number> = {
  conversation_closed: 0,
  order_created: 60,
  order_delivered: 180,
}

export interface CsatTemplateRef { template_name: string; template_language: string | null }
export type CsatMoments = Partial<Record<CsatMoment, CsatTemplateRef>>

/** Keep only known moments that name a template. */
export function normalizeMoments(raw: unknown): CsatMoments {
  const out: CsatMoments = {}
  if (!raw || typeof raw !== 'object') return out
  for (const m of CSAT_MOMENTS) {
    const v = (raw as Record<string, unknown>)[m] as Record<string, unknown> | undefined
    const name = typeof v?.template_name === 'string' ? v.template_name.trim() : ''
    if (!name) continue
    const lang = typeof v?.template_language === 'string' && v.template_language.trim() ? v.template_language.trim() : null
    out[m] = { template_name: name, template_language: lang }
  }
  return out
}

/** The template to send for `moment`, or null when that moment is off.
 *  An account saved before moments existed keeps deal_won → template_name. */
export function templateForMoment(
  config: { template_name: string | null; template_language: string | null; moments?: unknown },
  moment: CsatMoment,
): CsatTemplateRef | null {
  const moments = normalizeMoments(config.moments)
  if (Object.keys(moments).length) return moments[moment] ?? null
  return moment === 'deal_won' && config.template_name
    ? { template_name: config.template_name, template_language: config.template_language }
    : null
}

/** A low rating that deserves a follow-up task: 1–2 of 5, 1 of 3. */
export function isUnhappyScore(score: number, scale: number): boolean {
  return score <= Math.floor(scale * 0.4)
}
