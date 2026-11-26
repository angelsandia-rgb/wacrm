// ============================================================
// Response-time target — pure logic (no I/O). See migration 189 and
// sweep.ts. "Answered" = any teammate or bot message after the customer's
// latest burst, except the WhatsApp Business app's canned greeting/away
// echoes and internal notes.
// ============================================================

import { isBusinessAutoReply } from '@/lib/ai/human-reply'
import { isCourtesyClosing } from '@/lib/ai/reception-alert'

export type SlaStage = 'alert' | 'escalate' | 'ai_ack'

export interface SlaConfig {
  alert_minutes: number
  escalate_minutes: number
  ai_ack_minutes: number | null
  window_start_hour: number
  window_end_hour: number
}

export interface SlaMessage {
  sender_type: string
  content_type: string
  content_text: string | null
  created_at: string
}

/** First message of the customer's trailing unanswered burst, or null when
 *  the last word is ours or the customer only said thanks / ok.
 *  `newestFirst`: the conversation's latest messages, newest first. */
export function unansweredSince(newestFirst: SlaMessage[]): string | null {
  const burst: SlaMessage[] = []
  for (const m of newestFirst) {
    if (m.content_type === 'internal_note') continue
    if (m.sender_type === 'customer') {
      burst.push(m)
      continue
    }
    if ((m.sender_type === 'agent' || m.sender_type === 'bot') && !isBusinessAutoReply(m.content_text)) break
  }
  if (!burst.length) return null
  const texts = burst.map((m) => (m.content_text ?? '').trim()).filter(Boolean)
  // Media without text (photo, voice note) is a real request; only a burst of
  // nothing but courtesy ("gracias", "ok") needs no reply.
  if (texts.length === burst.length && texts.every((t) => isCourtesyClosing(t) || /^(ok|okay|oki|va|sale|listo)[.!\s]*$/i.test(t))) return null
  return burst[burst.length - 1].created_at
}

function minutesOfDay(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

/** Minutes the customer has waited inside the daily window, or null when
 *  it is outside the window right now (no notices at night). A message
 *  from last night starts counting when the window opens. */
export function waitingMinutes(sinceIso: string, now: Date, timeZone: string, startHour: number, endHour: number): number | null {
  const since = Date.parse(sinceIso)
  if (!Number.isFinite(since) || since > now.getTime()) return null
  if (startHour !== endHour && !(startHour === 0 && endHour === 24)) {
    const nowMin = minutesOfDay(now, timeZone)
    if (nowMin < startHour * 60 || nowMin >= endHour * 60) return null
    const windowStart = now.getTime() - (nowMin - startHour * 60) * 60_000
    return Math.floor((now.getTime() - Math.max(since, windowStart)) / 60_000)
  }
  return Math.floor((now.getTime() - since) / 60_000)
}

/** Stages due at `waited` minutes that have not fired yet, in order. */
export function dueStages(waited: number, cfg: SlaConfig, done: ReadonlySet<SlaStage>): SlaStage[] {
  const out: SlaStage[] = []
  if (waited >= cfg.alert_minutes && !done.has('alert')) out.push('alert')
  if (waited >= cfg.escalate_minutes && !done.has('escalate')) out.push('escalate')
  if (cfg.ai_ack_minutes != null && waited >= cfg.ai_ack_minutes && !done.has('ai_ack')) out.push('ai_ack')
  return out
}

/** Contacts that aren't customers: no response-time clock at all. ("Sin IA"
 *  contacts ARE customers — they get the clock, just no bot acknowledgement.) */
export function isNonCustomerTag(name: string | null | undefined): boolean {
  const key = (name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
  return key === 'interno' || key === 'personal' || key === 'proveedor'
}
