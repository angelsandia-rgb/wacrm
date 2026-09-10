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
const CLAIM_LEASE_MS = 15 * 60_000

function errorMessage(error: unknown): string {
  return error instanceof SendMessageError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error)
}

function safeTimeZone(timeZone: string | null): string {
  const candidate = timeZone?.trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format(new Date(0))
    return candidate
  } catch {
    console.error(`[clinic reminders] invalid timezone ${candidate}; falling back to UTC`)
    return 'UTC'
  }
}

async function claimConfirmation(
  db: SupabaseClient,
  appointmentId: string,
  claimedAt: string,
  staleBefore: string,
): Promise<boolean> {
  const { data, error } = await db.rpc('claim_clinic_confirmation_reminder', {
    p_appointment_id: appointmentId,
    p_claimed_at: claimedAt,
    p_stale_before: staleBefore,
  })
  if (error) throw error
  return data === true
}

async function claimFollowup(
  db: SupabaseClient,
  visitId: string,
  claimedAt: string,
  staleBefore: string,
): Promise<boolean> {
  const { data, error } = await db.rpc('claim_clinic_follow_up', {
    p_visit_id: visitId,
    p_claimed_at: claimedAt,
    p_stale_before: staleBefore,
  })
  if (error) throw error
  return data === true
}

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
    const { data, error } = await db
      .from('conversations')
      .select('id, status, channel')
      .eq('account_id', accountId)
      .eq('id', preferredId)
      .maybeSingle()
    if (error) throw error
    if (data && data.status === 'open' && MESSAGING_CHANNELS.has(data.channel as string)) {
      return data.id as string
    }
  }
  if (!contactId) return null
  const { data, error } = await db
    .from('conversations')
    .select('id, channel, last_message_at')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .in('channel', [...MESSAGING_CHANNELS])
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
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

  const { data: accts, error: accountsError } = await admin
    .from('accounts')
    .select('id, timezone')
    .eq('industry_vertical', 'clinica')
    .limit(MAX_ACCOUNTS)
  if (accountsError) throw accountsError
  const accounts = (accts ?? []) as { id: string; timezone: string | null }[]
  res.accounts = accounts.length
  if (accounts.length === 0) return res

  const acctIds = accounts.map((a) => a.id)
  const tzByAcct = new Map(accounts.map((a) => [a.id, safeTimeZone(a.timezone)]))
  const win = confirmationWindow(now)

  // ── 1 + 2 : confirmations & no-response ──────────────────────
  const { data: apptData, error: appointmentsError } = await admin
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
  if (appointmentsError) throw appointmentsError
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
      if (error) {
        res.failed += 1
        console.error('[clinic reminders] no-response update failed:', errorMessage(error))
      } else {
        res.noResponseFlagged += 1
      }
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

    const claimedAt = new Date().toISOString()
    const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString()
    if (!(await claimConfirmation(admin, a.id, claimedAt, staleBefore))) {
      res.skipped += 1
      continue
    }

    let messageDelivered = false
    try {
      const tz = tzByAcct.get(a.account_id) || 'UTC'
      const convId = await resolveConversation(
        admin,
        a.account_id,
        a.conversation_id,
        a.patient_profiles?.contact_id ?? null,
      )
      if (!convId) throw new Error('no open messaging conversation for patient')
      sendsLeft -= 1
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
      messageDelivered = true
      const { error: stampError } = await admin
        .from('appointments')
        .update({
          confirmation_reminder_sent_at: new Date().toISOString(),
          confirmation_reminder_claimed_at: null,
          confirmation_reminder_last_error: null,
        })
        .eq('account_id', a.account_id)
        .eq('id', a.id)
        .eq('confirmation_reminder_claimed_at', claimedAt)
      if (stampError) throw stampError
      res.confirmationsSent += 1
    } catch (e) {
      res.failed += 1
      const message = errorMessage(e).slice(0, 500)
      console.error('[clinic reminders] confirmation send failed:', message)
      // If WhatsApp accepted the message but the final DB stamp failed,
      // keep the lease until it expires instead of retrying immediately.
      // This reduces duplicates during a transient database incident.
      if (messageDelivered) continue
      const { error: releaseError } = await admin
        .from('appointments')
        .update({
          confirmation_reminder_claimed_at: null,
          confirmation_reminder_last_error: message,
        })
        .eq('account_id', a.account_id)
        .eq('id', a.id)
        .eq('confirmation_reminder_claimed_at', claimedAt)
      if (releaseError) {
        console.error('[clinic reminders] confirmation claim release failed:', errorMessage(releaseError))
      }
    }
  }

  // ── 3 : follow-ups ──────────────────────────────────────────
  const { data: visitData, error: visitsError } = await admin
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
  if (visitsError) throw visitsError
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
    const { data: future, error: futureError } = await admin
      .from('appointments')
      .select('id, status')
      .eq('account_id', v.account_id)
      .eq('patient_id', v.patient_id)
      .gte('scheduled_at', now.toISOString())
      .limit(20)
    if (futureError) {
      res.failed += 1
      console.error('[clinic reminders] future appointment lookup failed:', errorMessage(futureError))
      continue
    }
    if ((future ?? []).some((f) => LIVE_APPT.has(f.status as string))) {
      // stamp so we don't keep re-checking a patient who's already booked
      const { error } = await admin
        .from('visits')
        .update({ follow_up_nudged_at: now.toISOString() })
        .eq('account_id', v.account_id)
        .eq('id', v.id)
        .is('follow_up_nudged_at', null)
      if (error) {
        res.failed += 1
        console.error('[clinic reminders] follow-up closeout failed:', errorMessage(error))
      }
      res.skipped += 1
      continue
    }
    if (sendsLeft <= 0) {
      res.skipped += 1
      continue
    }

    const claimedAt = new Date().toISOString()
    const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString()
    if (!(await claimFollowup(admin, v.id, claimedAt, staleBefore))) {
      res.skipped += 1
      continue
    }
    let messageDelivered = false
    try {
      const convId = await resolveConversation(
        admin,
        v.account_id,
        null,
        v.patient_profiles?.contact_id ?? null,
      )
      if (!convId) throw new Error('no open messaging conversation for patient')
      sendsLeft -= 1
      await sendMessageToConversation(admin, v.account_id, {
        conversationId: convId,
        messageType: 'text',
        contentText: renderFollowupMessage({
          patientName: v.patient_profiles?.contacts?.name ?? null,
          doctorName: v.doctor_profiles?.display_name ?? null,
        }),
        senderType: 'bot',
      })
      messageDelivered = true
      const { error: stampError } = await admin
        .from('visits')
        .update({
          follow_up_nudged_at: new Date().toISOString(),
          follow_up_claimed_at: null,
          follow_up_last_error: null,
        })
        .eq('account_id', v.account_id)
        .eq('id', v.id)
        .eq('follow_up_claimed_at', claimedAt)
      if (stampError) throw stampError
      res.followupsSent += 1
    } catch (e) {
      res.failed += 1
      const message = errorMessage(e).slice(0, 500)
      console.error('[clinic reminders] follow-up send failed:', message)
      if (messageDelivered) continue
      const { error: releaseError } = await admin
        .from('visits')
        .update({ follow_up_claimed_at: null, follow_up_last_error: message })
        .eq('account_id', v.account_id)
        .eq('id', v.id)
        .eq('follow_up_claimed_at', claimedAt)
      if (releaseError) {
        console.error('[clinic reminders] follow-up claim release failed:', errorMessage(releaseError))
      }
    }
  }

  return res
}
