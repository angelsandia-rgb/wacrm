import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// The one upcoming appointment the auto-reply bot may act on for a
// clinic conversation — so the patient can confirm or cancel it just by
// replying. Deliberately narrow: exactly the soonest still-open
// appointment for the conversation's patient. Reschedules are NOT done
// from chat (the bot offers reception instead).
// ============================================================

const OPEN_STATUSES = ['SCHEDULED', 'RESCHEDULED', 'CONFIRMED', 'NO_RESPONSE']

export interface ClinicAppointmentContext {
  id: string
  /** Spanish one-liner for the prompt, e.g.
   *  "cabalgata... jueves 12 a las 9:00 AM con Dra. Ruiz". */
  summary: string
  confirmationStatus: string
  status: string
}

export async function loadClinicAppointmentContext(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  timezone: string,
): Promise<ClinicAppointmentContext | null> {
  // conversation -> contact -> patient profile
  const { data: conv } = await db
    .from('conversations')
    .select('contact_id')
    .eq('account_id', accountId)
    .eq('id', conversationId)
    .maybeSingle()
  const contactId = conv?.contact_id as string | undefined
  if (!contactId) return null

  const { data: patient } = await db
    .from('patient_profiles')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (!patient) return null

  const { data: appt } = await db
    .from('appointments')
    .select('id, scheduled_at, status, confirmation_status, doctor_profiles(display_name), products(name)')
    .eq('account_id', accountId)
    .eq('patient_id', patient.id)
    .in('status', OPEN_STATUSES)
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!appt) return null

  const when = new Intl.DateTimeFormat('es-GT', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(appt.scheduled_at as string))
  const doc = (appt.doctor_profiles as { display_name?: string } | null)?.display_name
  const svc = (appt.products as { name?: string } | null)?.name
  const parts = [svc, when, doc ? `con ${doc}` : null].filter(Boolean)

  return {
    id: appt.id as string,
    summary: parts.join(' · '),
    confirmationStatus: appt.confirmation_status as string,
    status: appt.status as string,
  }
}
