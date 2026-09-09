// ============================================================
// Clinic reminder sweep — the DB side of appointment confirmations and
// visit follow-ups. Called once per tick by
// /api/clinic/reminders/cron.
//
// Three passes, per `clinica` account:
//   1. CONFIRM — appointments ~24h out, confirmation still pending, no
//      reminder sent yet → send "¿Confirmas tu asistencia?", stamp
//      `confirmation_reminder_sent_at`.
//   2. NO-RESPONSE — a reminder went out, the grace window passed and
//      the appointment is imminent/past with no reply → flip
//      `confirmation_status` to 'no_response' (shows in Atención
//      requerida). No message.
//   3. FOLLOW-UP — a visit's recommended follow-up date has passed, the
//      patient has no live upcoming appointment and hasn't been nudged
//      → send "¿Quieres que te muestre horarios disponibles?", stamp
//      `follow_up_nudged_at`.
//
// Sends go through the same `sendMessageToConversation` the inbox /
// flows / followups use, as `sender_type = 'bot'`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'
import { dateKeyInZone } from '@/lib/timezone'
import {
  confirmationWindow,
  humanWhen,
  isNoResponseDue,
  renderConfirmationMessage,
  renderFollowupMessage,
} from './reminders'

const MESSAGING_CHANNELS = new Set(['whatsapp', 'instagram', 'facebook'])
const LIVE_APPT = new Set(['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_RESPONSE'])
const MAX_SENDS_PER_RUN = 150
const MAX_ACCOUNTS = 200

export interface ClinicReminderResult {
  accounts: number
  confirmationsSent: number
  noResponseFlagged: number
  followupsSent: number
  failed: number
  skipped: number
}

interface ApptRow {
  id: string
  account_id: string
  scheduled_at: string
  status: string
  confirmation_status: string
  confirmation_reminder_sent_at: string | null
  conversation_id: string | null
  patient_id: string
  patient_profiles: { contact_id: string; contacts: { name: string | null } | null } | null
  doctor_profiles: { display_name: string | null } | null
}

/** The open messaging conversation to reach a patient on: the one the
 *  appointment was booked from, else the patient's most recent open
 *  messaging conversation. `null` = can't reach them in-app. */
async function resolveConversation(
  db: SupabaseClient,
  accountId: string,
  preferredId: string | null,
  contactId: string | null,
): Promise<string | null> {
  if (preferredId) {
    const { data } = await db
      .from('conversations')
      .select('id, status, channel')
      .eq('account_id', accountId)
      .eq('id', preferredId)
      .maybeSingle()
    if (data && data.status === 'open' && MESSAGING_CHANNELS.has(data.channel as string)) {
      return data.id as string
    }
  }
  if (!contactId) return null
  const { data } = await db
    .from('conversations')
    .select('id, channel, last_message_at')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .in('channel', [...MESSAGING_CHANNELS])
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.id as string) ?? null
}

export async function runClinicReminderSweep(admin: SupabaseClient): Promise<ClinicReminderResult> {
  const res: ClinicReminderResult = {
    accounts: 0,
    confirmationsSent: 0,
    noResponseFlagged: 0,
    followupsSent: 0,
    failed: 0,
    skipped: 0,
  }
  const now = new Date()
  let sendsLeft = MAX_SENDS_PER_RUN

  const { data: accts } = await admin
    .from('accounts')
    .select('id, timezone')
    .eq('industry_vertical', 'clinica')
    .limit(MAX_ACCOUNTS)
  const accounts = (accts ?? []) as { id: string; timezone: string | null }[]
  res.accounts = accounts.length
  if (accounts.length === 0) return res

  const acctIds = accounts.map((a) => a.id)
  const tzByAcct = new Map(accounts.map((a) => [a.id, a.timezone || 'UTC']))
  const win = confirmationWindow(now)

  // ── 1 + 2 : confirmations & no-response ──────────────────────
  const { data: apptData } = await admin
    .from('appointments')
    .select(
      `id, account_id, scheduled_at, status, confirmation_status, confirmation_reminder_sent_at,
       conversation_id, patient_id,
       patient_profiles!inner(contact_id, contacts!inner(name)),
       doctor_profiles(display_name)`,
    )
    .in('account_id', acctIds)
    .in('status', ['SCHEDULED', 'RESCHEDULED'])
    .eq('confirmation_status', 'pending')
    .lte('scheduled_at', win.to)
    .order('scheduled_at', { ascending: true })
    .limit(1000)
  const appts = (apptData ?? []) as unknown as ApptRow[]

  for (const a of appts) {
    // no-response first (no send, cheap)
    if (
      isNoResponseDue({
        reminderSentAt: a.confirmation_reminder_sent_at,
        scheduledAt: a.scheduled_at,
        now,
      })
    ) {
      const { error } = await admin
        .from('appointments')
        .update({ confirmation_status: 'no_response' })
        .eq('account_id', a.account_id)
        .eq('id', a.id)
        .eq('confirmation_status', 'pending')
      if (!error) res.noResponseFlagged += 1
      continue
    }

    // due for a confirmation reminder?
    if (a.confirmation_reminder_sent_at) {
      res.skipped += 1
      continue
    }
    if (a.scheduled_at < win.from || a.scheduled_at > win.to) {
      res.skipped += 1
      continue
    }
    if (sendsLeft <= 0) {
      res.skipped += 1
      continue
    }

    const tz = tzByAcct.get(a.account_id) || 'UTC'
    const convId = await resolveConversation(
      admin,
      a.account_id,
      a.conversation_id,
      a.patient_profiles?.contact_id ?? null,
    )
    // stamp regardless so we attempt exactly once
    await admin
      .from('appointments')
      .update({ confirmation_reminder_sent_at: now.toISOString() })
      .eq('account_id', a.account_id)
      .eq('id', a.id)

    if (!convId) {
      res.skipped += 1
      continue
    }
    sendsLeft -= 1
    try {
      await sendMessageToConversation(admin, a.account_id, {
        conversationId: convId,
        messageType: 'text',
        contentText: renderConfirmationMessage({
          patientName: a.patient_profiles?.contacts?.name ?? null,
          timeLabel: humanWhen(a.scheduled_at, tz, now),
          doctorName: a.doctor_profiles?.display_name ?? null,
        }),
        senderType: 'bot',
      })
      res.confirmationsSent += 1
    } catch (e) {
      res.failed += 1
      console.error(
        '[clinic reminders] confirmation send failed:',
        e instanceof SendMessageError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : e,
      )
    }
  }

  // ── 3 : follow-ups ──────────────────────────────────────────
  const { data: visitData } = await admin
    .from('visits')
    .select(
      `id, account_id, patient_id, doctor_id, follow_up_date,
       patient_profiles!inner(contact_id, contacts!inner(name)),
       doctor_profiles(display_name)`,
    )
    .in('account_id', acctIds)
    .not('follow_up_date', 'is', null)
    .is('follow_up_nudged_at', null)
    .order('follow_up_date', { ascending: true })
    .limit(500)
  const visits = (visitData ?? []) as unknown as {
    id: string
    account_id: string
    patient_id: string
    follow_up_date: string
    patient_profiles: { contact_id: string; contacts: { name: string | null } | null } | null
    doctor_profiles: { display_name: string | null } | null
  }[]

  for (const v of visits) {
    const tz = tzByAcct.get(v.account_id) || 'UTC'
    if (v.follow_up_date > dateKeyInZone(now, tz)) {
      res.skipped += 1
      continue
    }
    // patient must have no live upcoming appointment
    const { data: future } = await admin
      .from('appointments')
      .select('id, status')
      .eq('account_id', v.account_id)
      .eq('patient_id', v.patient_id)
      .gte('scheduled_at', now.toISOString())
      .limit(20)
    if ((future ?? []).some((f) => LIVE_APPT.has(f.status as string))) {
      // stamp so we don't keep re-checking a patient who's already booked
      await admin.from('visits').update({ follow_up_nudged_at: now.toISOString() }).eq('id', v.id)
      res.skipped += 1
      continue
    }
    if (sendsLeft <= 0) {
      res.skipped += 1
      continue
    }

    const convId = await resolveConversation(
      admin,
      v.account_id,
      null,
      v.patient_profiles?.contact_id ?? null,
    )
    await admin.from('visits').update({ follow_up_nudged_at: now.toISOString() }).eq('id', v.id)
    if (!convId) {
      res.skipped += 1
      continue
    }
    sendsLeft -= 1
    try {
      await sendMessageToConversation(admin, v.account_id, {
        conversationId: convId,
        messageType: 'text',
        contentText: renderFollowupMessage({
          patientName: v.patient_profiles?.contacts?.name ?? null,
          doctorName: v.doctor_profiles?.display_name ?? null,
        }),
        senderType: 'bot',
      })
      res.followupsSent += 1
    } catch (e) {
      res.failed += 1
      console.error(
        '[clinic reminders] follow-up send failed:',
        e instanceof SendMessageError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : e,
      )
    }
  }

  return res
}
