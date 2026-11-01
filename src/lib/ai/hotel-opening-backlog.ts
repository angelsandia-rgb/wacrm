import type { SupabaseClient } from '@supabase/supabase-js'
import { withinAiAttentionHours, type AutoReplySchedule } from './auto-reply-schedule'
import { loadTrailingOutbound } from './human-reply'
import { isSimpleAcknowledgement } from './reception-alert'

export const HOTEL_DAYTIME_BACKLOG_MS = 24 * 60 * 60_000

/** Unanswered daytime questions become eligible when the overnight shift starts.
 * This is a reply to an inbound, never a proactive sales follow-up. */
export function isHotelDaytimeBacklog(schedule: AutoReplySchedule | null | undefined, customerAt: string, now: Date): boolean {
  const at = new Date(customerAt)
  const age = now.getTime() - at.getTime()
  return Boolean(schedule && schedule.startHour > schedule.endHour && Number.isFinite(age)
    && age >= 0 && age <= HOTEL_DAYTIME_BACKLOG_MS
    && withinAiAttentionHours(schedule, now) && !withinAiAttentionHours(schedule, at))
}

export function isOnlyAcknowledgement(text?: string | null): boolean {
  return Boolean(text && (isSimpleAcknowledgement(text) || /^muy bien[.!\s]*$/i.test(text.trim())))
}

/** Rechecked by dispatch so a person replying after the sweep wins. */
export async function canResumeHotelDaytimeInquiry(db: SupabaseClient, conversationId: string, schedule: AutoReplySchedule | null | undefined, resetAt: string | null, now = new Date()): Promise<boolean> {
  const { data: customer, error } = await db.from('messages').select('content_type,content_text,created_at')
    .eq('conversation_id', conversationId).eq('sender_type', 'customer').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error || !customer || customer.content_type !== 'text' || isOnlyAcknowledgement(customer.content_text)
    || !isHotelDaytimeBacklog(schedule, customer.created_at, now)) return false
  const { rows } = await loadTrailingOutbound(db, conversationId, resetAt)
  return rows.length === 0
}
