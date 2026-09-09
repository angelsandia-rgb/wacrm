// ============================================================
// Clinic operating metrics — pure, no I/O, unit-tested. All windows are
// [from, to) ISO instants; day bucketing uses the clinic's IANA
// timezone. "Ingresos" is SUM(visits.amount) for visits in the window
// (a visit IS a completed, billable consultation).
// ============================================================

import type {
  AppointmentsByDayPoint,
  AppointmentsStat,
  AttentionRequired,
  ConversionsStat,
  HumanResponseStat,
  PatientSegmentStat,
  RevenueStat,
  UpcomingAppointment,
} from './types'

export interface VisitRow {
  patient_id: string
  visit_date: string // yyyy-mm-dd
  amount: number | string | null
  follow_up_date?: string | null
}

export interface AppointmentRow {
  id: string
  scheduled_at: string
  status: string
  confirmation_status: string
  patient_id?: string | null
  patient_name?: string | null
  doctor_name?: string | null
  service_name?: string | null
}

export interface MessageRow {
  conversation_id: string
  sender_type: string // customer | agent | bot
  ai_generated: boolean
  created_at: string
}

const DAY_MS = 86_400_000
const BLOCKING = new Set(['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_RESPONSE'])

function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function inWindow(iso: string, from: string, to: string): boolean {
  const t = Date.parse(iso)
  return Number.isFinite(t) && t >= Date.parse(from) && t < Date.parse(to)
}

/** yyyy-mm-dd of an ISO instant in `tz`. */
export function dayKey(iso: string, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>
  return `${p.year}-${p.month}-${p.day}`
}

// ── Revenue ───────────────────────────────────────────────────
export function computeRevenue(
  visits: VisitRow[],
  window: { from: string; to: string },
  prevWindow: { from: string; to: string },
): RevenueStat {
  const sumIn = (w: { from: string; to: string }) =>
    visits.reduce(
      (s, v) => (inWindow(`${v.visit_date}T12:00:00Z`, w.from, w.to) ? s + num(v.amount) : s),
      0,
    )
  const total = sumIn(window)
  const previousPeriod = sumIn(prevWindow)
  const percentageChange =
    previousPeriod > 0 ? ((total - previousPeriod) / previousPeriod) * 100 : total > 0 ? null : 0
  return { total, previousPeriod, percentageChange }
}

// ── New vs returning patients ────────────────────────────────
/**
 * `allVisits` must be every visit for the account (to know each
 * patient's first-ever visit). A patient is NEW when their earliest
 * visit falls inside the window; RETURNING when they had a visit before
 * the window and at least one inside it. Revenue is that patient's
 * in-window visit total.
 */
export function classifyPatients(
  allVisits: VisitRow[],
  window: { from: string; to: string },
): { newPatients: PatientSegmentStat; returningPatients: PatientSegmentStat } {
  const firstByPatient = new Map<string, number>()
  for (const v of allVisits) {
    const t = Date.parse(`${v.visit_date}T12:00:00Z`)
    if (!Number.isFinite(t)) continue
    const cur = firstByPatient.get(v.patient_id)
    if (cur == null || t < cur) firstByPatient.set(v.patient_id, t)
  }

  const inWinByPatient = new Map<string, number>() // patient -> revenue in window
  for (const v of allVisits) {
    if (!inWindow(`${v.visit_date}T12:00:00Z`, window.from, window.to)) continue
    inWinByPatient.set(v.patient_id, (inWinByPatient.get(v.patient_id) ?? 0) + num(v.amount))
  }

  const wFrom = Date.parse(window.from)
  const wTo = Date.parse(window.to)
  let newCount = 0
  let newRev = 0
  let retCount = 0
  let retRev = 0
  for (const [pid, rev] of inWinByPatient) {
    const first = firstByPatient.get(pid)!
    if (first >= wFrom && first < wTo) {
      newCount += 1
      newRev += rev
    } else if (first < wFrom) {
      retCount += 1
      retRev += rev
    }
  }
  return {
    newPatients: { count: newCount, revenue: newRev },
    returningPatients: { count: retCount, revenue: retRev },
  }
}

// ── Appointments ─────────────────────────────────────────────
export function computeAppointments(
  appts: AppointmentRow[],
  window: { from: string; to: string },
): AppointmentsStat {
  const inWin = appts.filter((a) => inWindow(a.scheduled_at, window.from, window.to))
  const total = inWin.length
  const confirmed = inWin.filter((a) => a.confirmation_status === 'confirmed').length
  const requiredConfirmation = inWin.filter((a) => a.confirmation_status !== 'not_required').length
  const noShows = inWin.filter((a) => a.status === 'NO_SHOW').length
  return {
    total,
    confirmed,
    noShows,
    confirmationRate: requiredConfirmation > 0 ? (confirmed / requiredConfirmation) * 100 : null,
    noShowRate: total > 0 ? (noShows / total) * 100 : null,
  }
}

// ── Conversion funnel ────────────────────────────────────────
export function computeConversions(
  conversationsCount: number,
  appts: AppointmentRow[],
  visits: VisitRow[],
  window: { from: string; to: string },
): ConversionsStat {
  const bookedAppointments = appts.filter((a) => inWindow(a.scheduled_at, window.from, window.to)).length
  const completedVisits = visits.filter((v) =>
    inWindow(`${v.visit_date}T12:00:00Z`, window.from, window.to),
  ).length
  return {
    conversations: conversationsCount,
    bookedAppointments,
    completedVisits,
    bookingConversionRate: conversationsCount > 0 ? (bookedAppointments / conversationsCount) * 100 : null,
    completedConversionRate:
      conversationsCount > 0 ? (completedVisits / conversationsCount) * 100 : null,
  }
}

// ── Human response time ──────────────────────────────────────
/**
 * Mean seconds from a customer's inbound message to the first HUMAN
 * reply (sender_type 'agent' AND NOT ai_generated) in the same
 * conversation. `messages` should be the account's messages in the
 * window, any order. One pair per conversation.
 */
export function computeHumanResponse(messages: MessageRow[]): HumanResponseStat {
  const byConv = new Map<string, MessageRow[]>()
  for (const m of messages) {
    const list = byConv.get(m.conversation_id)
    if (list) list.push(m)
    else byConv.set(m.conversation_id, [m])
  }
  const deltas: number[] = []
  for (const list of byConv.values()) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    const firstCustomer = list.find((m) => m.sender_type === 'customer')
    if (!firstCustomer) continue
    const ct = Date.parse(firstCustomer.created_at)
    const firstHuman = list.find(
      (m) => m.sender_type === 'agent' && !m.ai_generated && Date.parse(m.created_at) >= ct,
    )
    if (!firstHuman) continue
    const d = (Date.parse(firstHuman.created_at) - ct) / 1000
    if (d >= 0 && d < 7 * 24 * 3600) deltas.push(d) // drop week-plus outliers
  }
  if (deltas.length === 0) return { averageSeconds: null, sampleSize: 0 }
  return {
    averageSeconds: deltas.reduce((s, d) => s + d, 0) / deltas.length,
    sampleSize: deltas.length,
  }
}

// ── Attention required ───────────────────────────────────────
export function computeAttention(args: {
  appts: AppointmentRow[]
  visits: VisitRow[]
  conversationsWaiting: number
  nowISO: string
  todayISODate: string
}): AttentionRequired {
  const now = Date.parse(args.nowISO)
  const unconfirmedAppointments = args.appts.filter(
    (a) =>
      Date.parse(a.scheduled_at) >= now &&
      (a.status === 'SCHEDULED' || a.status === 'RESCHEDULED' || a.status === 'NO_RESPONSE') &&
      a.confirmation_status !== 'confirmed' &&
      a.confirmation_status !== 'not_required',
  ).length

  const noShows = args.appts.filter(
    (a) =>
      a.status === 'NO_SHOW' &&
      Date.parse(a.scheduled_at) >= now - 7 * DAY_MS &&
      Date.parse(a.scheduled_at) < now,
  ).length

  // follow-ups due: a recommended follow-up date passed AND the patient
  // has no live upcoming appointment.
  const futureByPatient = new Set<string>()
  for (const a of args.appts) {
    if (a.patient_id && BLOCKING.has(a.status) && Date.parse(a.scheduled_at) >= now) {
      futureByPatient.add(a.patient_id)
    }
  }
  const latestFollowUp = new Map<string, string>()
  for (const v of args.visits) {
    if (!v.follow_up_date) continue
    const prev = latestFollowUp.get(v.patient_id)
    if (!prev || v.follow_up_date > prev) latestFollowUp.set(v.patient_id, v.follow_up_date)
  }
  let followUps = 0
  for (const [pid, d] of latestFollowUp) {
    if (d <= args.todayISODate && !futureByPatient.has(pid)) followUps += 1
  }

  return {
    unconfirmedAppointments,
    noShows,
    followUps,
    conversationsWaiting: args.conversationsWaiting,
  }
}

// ── Upcoming ─────────────────────────────────────────────────
export function upcomingAppointments(
  appts: AppointmentRow[],
  nowISO: string,
  limit = 8,
): UpcomingAppointment[] {
  const now = Date.parse(nowISO)
  return appts
    .filter((a) => Date.parse(a.scheduled_at) >= now && BLOCKING.has(a.status))
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      scheduled_at: a.scheduled_at,
      patient_name: a.patient_name ?? null,
      doctor_name: a.doctor_name ?? null,
      service_name: a.service_name ?? null,
      status: a.status,
      confirmation_status: a.confirmation_status,
    }))
}

// ── Appointments per day ─────────────────────────────────────
export function appointmentsByDay(
  appts: AppointmentRow[],
  window: { from: string; to: string },
  tz: string,
): AppointmentsByDayPoint[] {
  const buckets = new Map<string, AppointmentsByDayPoint>()
  // seed every day in the window so the chart has no gaps
  let cursor = Date.parse(window.from)
  const end = Date.parse(window.to)
  let guard = 0
  while (cursor < end && guard < 400) {
    const k = dayKey(new Date(cursor).toISOString(), tz)
    if (!buckets.has(k)) buckets.set(k, { date: k, scheduled: 0, confirmed: 0, completed: 0, noShows: 0 })
    cursor += DAY_MS
    guard += 1
  }
  for (const a of appts) {
    if (!inWindow(a.scheduled_at, window.from, window.to)) continue
    const k = dayKey(a.scheduled_at, tz)
    const b = buckets.get(k) ?? { date: k, scheduled: 0, confirmed: 0, completed: 0, noShows: 0 }
    b.scheduled += 1
    if (a.status === 'CONFIRMED') b.confirmed += 1
    if (a.status === 'COMPLETED') b.completed += 1
    if (a.status === 'NO_SHOW') b.noShows += 1
    buckets.set(k, b)
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))
}
