import type { SupabaseClient } from '@supabase/supabase-js'
import { type PatientSource } from './types'

// ============================================================
// Patients — a thin profile (`patient_profiles`) over a `contacts` row,
// plus the derived numbers the list and the profile header show:
// last visit, next appointment, total visits, lifetime value, and
// whether a recommended follow-up is now due.
//
// The aggregation is done in JS over the account's `visits` +
// `appointments` (both small per clinic). If a clinic ever outgrows
// that, move `buildPatientAggregates` into a SQL view / RPC — the
// shape here is what the dashboard phase will want anyway.
// ============================================================

export type PatientFilter =
  | 'all'
  | 'new'
  | 'returning'
  | 'upcoming'
  | 'no_future'
  | 'follow_up_due'

export const PATIENT_FILTERS: readonly PatientFilter[] = [
  'all',
  'new',
  'returning',
  'upcoming',
  'no_future',
  'follow_up_due',
] as const

export function isPatientFilter(v: unknown): v is PatientFilter {
  return typeof v === 'string' && (PATIENT_FILTERS as readonly string[]).includes(v)
}

/** Appointment statuses that still count as "the patient has a real
 *  upcoming appointment". */
const LIVE_APPOINTMENT_STATUSES = new Set(['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_RESPONSE'])

export interface PatientAggregate {
  last_visit_date: string | null
  next_appointment_at: string | null
  visit_count: number
  total_value: number
  follow_up_due: boolean
}

export interface VisitAggInput {
  patient_id: string
  visit_date: string | null
  amount: number | string | null
  follow_up_date: string | null
}
export interface AppointmentAggInput {
  patient_id: string
  scheduled_at: string
  status: string
}

/**
 * Fold the account's visits + appointments into one aggregate per
 * patient. `todayISODate` is `yyyy-mm-dd` in the clinic's timezone —
 * used only for the follow-up-due test.
 */
export function buildPatientAggregates(
  visits: VisitAggInput[],
  appointments: AppointmentAggInput[],
  nowISO: string,
  todayISODate: string,
): Map<string, PatientAggregate> {
  const now = new Date(nowISO).getTime()
  const out = new Map<string, PatientAggregate>()

  const ensure = (id: string): PatientAggregate => {
    let a = out.get(id)
    if (!a) {
      a = {
        last_visit_date: null,
        next_appointment_at: null,
        visit_count: 0,
        total_value: 0,
        follow_up_due: false,
      }
      out.set(id, a)
    }
    return a
  }

  // track, per patient, the latest recommended follow-up date across visits
  const latestFollowUp = new Map<string, string>()

  for (const v of visits) {
    const a = ensure(v.patient_id)
    a.visit_count += 1
    const amt = v.amount == null ? 0 : Number(v.amount)
    if (Number.isFinite(amt)) a.total_value += amt
    if (v.visit_date && (!a.last_visit_date || v.visit_date > a.last_visit_date)) {
      a.last_visit_date = v.visit_date
    }
    if (v.follow_up_date) {
      const prev = latestFollowUp.get(v.patient_id)
      if (!prev || v.follow_up_date > prev) latestFollowUp.set(v.patient_id, v.follow_up_date)
    }
  }

  for (const appt of appointments) {
    if (!LIVE_APPOINTMENT_STATUSES.has(appt.status)) continue
    const t = new Date(appt.scheduled_at).getTime()
    if (!Number.isFinite(t) || t < now) continue
    const a = ensure(appt.patient_id)
    if (!a.next_appointment_at || appt.scheduled_at < a.next_appointment_at) {
      a.next_appointment_at = appt.scheduled_at
    }
  }

  // follow-up due = a recommended follow-up date has passed AND there is
  // no live upcoming appointment on the books.
  for (const [id, followUp] of latestFollowUp) {
    const a = ensure(id)
    if (followUp <= todayISODate && !a.next_appointment_at) a.follow_up_due = true
  }

  return out
}

export interface PatientListRow {
  id: string
  contact_id: string
  name: string | null
  phone: string | null
  email: string | null
  source: PatientSource | null
  created_at: string
  last_visit_date: string | null
  next_appointment_at: string | null
  visit_count: number
  total_value: number
  follow_up_due: boolean
}

const EMPTY_AGG: PatientAggregate = {
  last_visit_date: null,
  next_appointment_at: null,
  visit_count: 0,
  total_value: 0,
  follow_up_due: false,
}

export function matchesPatientFilter(row: PatientListRow, filter: PatientFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'new':
      return row.visit_count <= 1
    case 'returning':
      return row.visit_count >= 2
    case 'upcoming':
      return row.next_appointment_at != null
    case 'no_future':
      return row.next_appointment_at == null
    case 'follow_up_due':
      return row.follow_up_due
  }
}

export interface ListPatientsOptions {
  filter?: PatientFilter
  search?: string
  limit?: number
  offset?: number
  /** clinic timezone `yyyy-mm-dd` today + ISO now, for the follow-up test. */
  todayISODate: string
  nowISO: string
}

export interface ListPatientsResult {
  rows: PatientListRow[]
  total: number
}

/**
 * List patients for an account with the derived columns, filtered and
 * searched. `supabase` is the caller's RLS-scoped client.
 */
export async function listPatients(
  supabase: SupabaseClient,
  accountId: string,
  opts: ListPatientsOptions,
): Promise<ListPatientsResult> {
  const search = (opts.search ?? '').trim()
  const filter = opts.filter ?? 'all'
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)

  // 1. patient profiles + their contact
  const { data: profiles, error: pErr } = await supabase
    .from('patient_profiles')
    .select('id, contact_id, source, created_at, contacts!inner(id, name, phone, phone_normalized, email)')
    .eq('account_id', accountId)
  if (pErr) throw pErr

  type Row = {
    id: string
    contact_id: string
    source: PatientSource | null
    created_at: string
    contacts: { name: string | null; phone: string | null; phone_normalized: string | null; email: string | null } | null
  }
  let base = (profiles ?? []) as unknown as Row[]

  if (search) {
    const needle = search.toLowerCase()
    const digits = needle.replace(/\D/g, '')
    base = base.filter((r) => {
      const c = r.contacts
      if (!c) return false
      return (
        (c.name ?? '').toLowerCase().includes(needle) ||
        (c.email ?? '').toLowerCase().includes(needle) ||
        (!!digits && ((c.phone_normalized ?? '') + (c.phone ?? '')).replace(/\D/g, '').includes(digits))
      )
    })
  }

  // 2. aggregates from the whole account's visits + appointments
  const patientIds = base.map((r) => r.id)
  let aggregates = new Map<string, PatientAggregate>()
  if (patientIds.length > 0) {
    const [{ data: visits, error: vErr }, { data: appts, error: aErr }] = await Promise.all([
      supabase
        .from('visits')
        .select('patient_id, visit_date, amount, follow_up_date')
        .eq('account_id', accountId),
      supabase
        .from('appointments')
        .select('patient_id, scheduled_at, status')
        .eq('account_id', accountId)
        .gte('scheduled_at', opts.nowISO),
    ])
    if (vErr) throw vErr
    if (aErr) throw aErr
    aggregates = buildPatientAggregates(
      (visits ?? []) as VisitAggInput[],
      (appts ?? []) as AppointmentAggInput[],
      opts.nowISO,
      opts.todayISODate,
    )
  }

  // 3. assemble, filter, sort, paginate
  let rows: PatientListRow[] = base.map((r) => {
    const agg = aggregates.get(r.id) ?? EMPTY_AGG
    return {
      id: r.id,
      contact_id: r.contact_id,
      name: r.contacts?.name ?? null,
      phone: r.contacts?.phone ?? null,
      email: r.contacts?.email ?? null,
      source: r.source,
      created_at: r.created_at,
      last_visit_date: agg.last_visit_date,
      next_appointment_at: agg.next_appointment_at,
      visit_count: agg.visit_count,
      total_value: agg.total_value,
      follow_up_due: agg.follow_up_due,
    }
  })

  rows = rows.filter((r) => matchesPatientFilter(r, filter))
  rows.sort((a, b) => {
    // patients with an upcoming appointment first (soonest), then by name
    if (a.next_appointment_at && b.next_appointment_at) {
      return a.next_appointment_at.localeCompare(b.next_appointment_at)
    }
    if (a.next_appointment_at) return -1
    if (b.next_appointment_at) return 1
    return (a.name ?? '').localeCompare(b.name ?? '')
  })

  const total = rows.length
  return { rows: rows.slice(offset, offset + limit), total }
}
