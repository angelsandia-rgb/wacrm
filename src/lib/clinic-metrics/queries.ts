import type { SupabaseClient } from '@supabase/supabase-js'
import { dateKeyInZone } from '@/lib/timezone'
import {
  appointmentsByDay,
  classifyPatients,
  computeAppointments,
  computeAttention,
  computeConversions,
  computeHumanResponse,
  computeRevenue,
  upcomingAppointments,
  type AppointmentRow,
  type MessageRow,
  type VisitRow,
} from './compute'
import type { ClinicDashboardStats } from './types'

const DAY_MS = 86_400_000

/**
 * The clinic dashboard's single data load. `supabase` is the caller's
 * RLS-scoped client, so a restricted doctor-user's figures are already
 * limited to their own appointments / visits. Everything else the
 * frontend needs is computed here.
 */
export async function loadClinicDashboard(
  supabase: SupabaseClient,
  accountId: string,
  args: { from: string; to: string; currency: string; timezone: string },
): Promise<ClinicDashboardStats> {
  const { from, to, currency, timezone } = args
  const now = new Date()
  const nowISO = now.toISOString()
  const prevSpanMs = Date.parse(to) - Date.parse(from)
  const prevWindow = {
    from: new Date(Date.parse(from) - prevSpanMs).toISOString(),
    to: from,
  }
  // appointments window: the current window + prev + 60 days ahead
  // (upcoming / attention).
  const apptFrom = prevWindow.from
  const apptTo = new Date(Date.parse(to) + 60 * DAY_MS).toISOString()

  const [
    visitsResult,
    appointmentsResult,
    convCountRes,
    waitingResult,
    messagesResult,
  ] = await Promise.all([
    // every visit for the account — needed for first-visit-per-patient
    supabase
      .from('visits')
      .select('patient_id, visit_date, amount, follow_up_date')
      .eq('account_id', accountId),
    supabase
      .from('appointments')
      .select(
        `id, scheduled_at, status, confirmation_status, patient_id,
         patient_profiles!inner(contacts!inner(name)),
         doctor_profiles(display_name),
         products(name)`,
      )
      .eq('account_id', accountId)
      .gte('scheduled_at', apptFrom)
      .lt('scheduled_at', apptTo),
    supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .gte('created_at', from)
      .lt('created_at', to),
    // "waiting for a human": open, handed off, not yet auto-recovered.
    supabase
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('status', 'open')
      .not('ai_handoff_at', 'is', null)
      .is('ai_handoff_transient', null)
      .limit(500),
    supabase
      .from('messages')
      .select('conversation_id, sender_type, ai_generated, created_at, conversations!inner(account_id)')
      .eq('conversations.account_id', accountId)
      .gte('created_at', from)
      .lt('created_at', to)
      .limit(5000),
  ])
  const queryError =
    visitsResult.error ??
    appointmentsResult.error ??
    convCountRes.error ??
    waitingResult.error ??
    messagesResult.error
  if (queryError) throw queryError
  const allVisits = visitsResult.data
  const appts = appointmentsResult.data
  const waitingConvs = waitingResult.data
  const messages = messagesResult.data
  const conversationsInWindow = convCountRes.count ?? 0

  const visitRows = (allVisits ?? []) as VisitRow[]
  const apptRows: AppointmentRow[] = ((appts ?? []) as unknown as Record<string, unknown>[]).map((a) => {
    const pp = a.patient_profiles as { contacts?: { name?: string | null } } | null
    const doc = a.doctor_profiles as { display_name?: string } | null
    const svc = a.products as { name?: string } | null
    return {
      id: a.id as string,
      scheduled_at: a.scheduled_at as string,
      status: a.status as string,
      confirmation_status: a.confirmation_status as string,
      patient_id: (a.patient_id as string) ?? null,
      patient_name: pp?.contacts?.name ?? null,
      doctor_name: doc?.display_name ?? null,
      service_name: svc?.name ?? null,
    }
  })
  const messageRows: MessageRow[] = ((messages ?? []) as unknown as Record<string, unknown>[]).map((m) => ({
    conversation_id: m.conversation_id as string,
    sender_type: m.sender_type as string,
    ai_generated: Boolean(m.ai_generated),
    created_at: m.created_at as string,
  }))

  const window = { from, to }
  const revenue = computeRevenue(visitRows, window, prevWindow)
  const { newPatients, returningPatients } = classifyPatients(visitRows, window)
  const appointments = computeAppointments(apptRows, window)
  const conversions = computeConversions(conversationsInWindow, apptRows, visitRows, window)
  const humanResponse = computeHumanResponse(messageRows)
  const todayISODate = dateKeyInZone(now, timezone)
  const attentionRequired = computeAttention({
    appts: apptRows,
    visits: visitRows,
    conversationsWaiting: (waitingConvs ?? []).length,
    nowISO,
    todayISODate,
  })
  const upcoming = upcomingAppointments(apptRows, nowISO, 8)
  const byDay = appointmentsByDay(apptRows, window, timezone)

  return {
    range: { from, to },
    currency,
    revenue,
    newPatients,
    returningPatients,
    appointments,
    conversions,
    humanResponse,
    attentionRequired,
    upcoming,
    byDay,
  }
}
