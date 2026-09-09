import type { SupabaseClient } from '@supabase/supabase-js'
import { createEvent, updateEvent, deleteEvent } from '@/lib/google-calendar/api'

// ============================================================
// Best-effort mirror of a clinic appointment into the account's
// connected Google Calendar. Postgres is the source of truth; this is
// a convenience so the doctor / reception see the same in their Google
// Calendar app. Every function swallows its own errors — a mirror
// failure must never fail (or slow to a crawl) the appointment op.
// ============================================================

/** Whether the account has a Google Calendar connected. */
async function calendarConnected(db: SupabaseClient, accountId: string): Promise<boolean> {
  try {
    const { data } = await db
      .from('google_calendar_config')
      .select('calendar_id, status')
      .eq('account_id', accountId)
      .maybeSingle()
    return Boolean(data) && data?.status !== 'disconnected'
  } catch {
    return false
  }
}

interface ApptContext {
  patientName: string | null
  doctorName: string | null
  serviceName: string | null
  timezone: string
}

async function loadContext(
  db: SupabaseClient,
  accountId: string,
  appt: { patient_id: string; doctor_id: string; service_id: string | null },
): Promise<ApptContext> {
  const [{ data: pp }, { data: doc }, { data: svc }, { data: acct }] = await Promise.all([
    db.from('patient_profiles').select('contacts(name)').eq('id', appt.patient_id).maybeSingle(),
    db.from('doctor_profiles').select('display_name').eq('id', appt.doctor_id).maybeSingle(),
    appt.service_id
      ? db.from('products').select('name').eq('id', appt.service_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from('accounts').select('timezone').eq('id', accountId).maybeSingle(),
  ])
  return {
    patientName:
      (pp as { contacts?: { name?: string | null } } | null)?.contacts?.name ?? null,
    doctorName: (doc as { display_name?: string } | null)?.display_name ?? null,
    serviceName: (svc as { name?: string } | null)?.name ?? null,
    timezone: (acct as { timezone?: string | null } | null)?.timezone ?? 'UTC',
  }
}

function summaryFor(ctx: ApptContext): string {
  const who = ctx.patientName || 'Paciente'
  return ctx.serviceName ? `Cita: ${who} · ${ctx.serviceName}` : `Cita: ${who}`
}

function descriptionFor(ctx: ApptContext): string {
  const lines = ['Cita registrada en Sandía.']
  if (ctx.doctorName) lines.push(`Doctor: ${ctx.doctorName}`)
  if (ctx.serviceName) lines.push(`Servicio: ${ctx.serviceName}`)
  return lines.join('\n')
}

/**
 * Mirror freshly-created appointments. Writes the Google event id back
 * onto each row (`appointments.google_event_id`). One row's failure
 * doesn't stop the others.
 */
export async function mirrorAppointmentsCreated(
  db: SupabaseClient,
  accountId: string,
  appointments: {
    id: string
    patient_id: string
    doctor_id: string
    service_id: string | null
    scheduled_at: string
    ends_at: string
  }[],
): Promise<void> {
  try {
    if (appointments.length === 0) return
    if (!(await calendarConnected(db, accountId))) return
    const ctx = await loadContext(db, accountId, appointments[0])
    const summary = summaryFor(ctx)
    const description = descriptionFor(ctx)

    for (const a of appointments) {
      try {
        const ev = await createEvent(db, accountId, {
          summary,
          description,
          startISO: a.scheduled_at,
          endISO: a.ends_at,
          timeZone: ctx.timezone,
          withMeet: false,
          sendUpdates: 'none',
        })
        await db
          .from('appointments')
          .update({ google_event_id: ev.eventId })
          .eq('account_id', accountId)
          .eq('id', a.id)
      } catch (err) {
        console.error('[clinic calendar-sync] create mirror failed:', err instanceof Error ? err.message : err)
      }
    }
  } catch (err) {
    console.error('[clinic calendar-sync] create mirror threw:', err instanceof Error ? err.message : err)
  }
}

/** Mirror a reschedule — moves the linked Google event. */
export async function mirrorAppointmentRescheduled(
  db: SupabaseClient,
  accountId: string,
  appt: {
    id: string
    google_event_id: string | null
    patient_id: string
    doctor_id: string
    service_id: string | null
    scheduled_at: string
    ends_at: string
  },
): Promise<void> {
  try {
    if (!appt.google_event_id) return
    if (!(await calendarConnected(db, accountId))) return
    const ctx = await loadContext(db, accountId, appt)
    await updateEvent(db, accountId, appt.google_event_id, {
      startISO: appt.scheduled_at,
      endISO: appt.ends_at,
      summary: summaryFor(ctx),
      timeZone: ctx.timezone,
    })
  } catch (err) {
    console.error('[clinic calendar-sync] reschedule mirror failed:', err instanceof Error ? err.message : err)
  }
}

/** Mirror a cancellation — deletes the linked Google event and clears
 *  the stored id. */
export async function mirrorAppointmentCancelled(
  db: SupabaseClient,
  accountId: string,
  appt: { id: string; google_event_id: string | null },
): Promise<void> {
  try {
    if (!appt.google_event_id) return
    if (!(await calendarConnected(db, accountId))) return
    await deleteEvent(db, accountId, appt.google_event_id)
    await db
      .from('appointments')
      .update({ google_event_id: null })
      .eq('account_id', accountId)
      .eq('id', appt.id)
  } catch (err) {
    console.error('[clinic calendar-sync] cancel mirror failed:', err instanceof Error ? err.message : err)
  }
}
