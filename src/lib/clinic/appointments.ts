import type { SupabaseClient } from '@supabase/supabase-js'
import { computeFreeSlots, overlapsBusy, type BusyInterval } from './availability'
import {
  canTransitionAppointment,
  isTerminalAppointmentStatus,
  type AppointmentStatus,
  type ConfirmationStatus,
} from './appointment-status'
import { expandRecurrence, RECURRENCE_MAX_COUNT, RECURRENCE_MIN_COUNT } from './recurrence'
import { isRecurrenceFrequency, type RecurrenceFrequency } from './types'

// ============================================================
// Appointment operations — create (with optional recurrence), status
// transition, reschedule (with history), free-slot lookup, list.
// `supabase` is always the caller's RLS-scoped client so the
// doctor-scope policy applies; the tenant-guard triggers enforce FK
// ownership regardless.
// ============================================================

/** Statuses that still block a time slot on a doctor's calendar. */
const BLOCKING_STATUSES: AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_RESPONSE']

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface CreateAppointmentInput {
  patient_id: string
  doctor_id: string
  service_id?: string | null
  conversation_id?: string | null
  scheduled_at: string // ISO
  /** minutes; falls back to the service duration, then 30. */
  duration_minutes?: number | null
  amount?: number | null
  notes?: string | null
  needs_confirmation?: boolean
  recurrence?: { frequency: RecurrenceFrequency; count: number } | null
}

export interface CreateResult {
  ok: true
  ids: string[]
  recurrence_group_id: string | null
}
export interface OpError {
  ok: false
  error: string
  status: number
}

function fail(error: string, status = 400): OpError {
  return { ok: false, error, status }
}

/** Load the doctor's busy intervals (blocking appointments) in a window. */
export async function loadDoctorBusy(
  supabase: SupabaseClient,
  accountId: string,
  doctorId: string,
  fromISO: string,
  toISO: string,
  excludeAppointmentId?: string,
): Promise<BusyInterval[]> {
  let q = supabase
    .from('appointments')
    .select('id, scheduled_at, ends_at, status')
    .eq('account_id', accountId)
    .eq('doctor_id', doctorId)
    .lt('scheduled_at', toISO)
    .gt('ends_at', fromISO)
  if (excludeAppointmentId) q = q.neq('id', excludeAppointmentId)
  const { data } = await q
  return (data ?? [])
    .filter((r) => BLOCKING_STATUSES.includes(r.status as AppointmentStatus))
    .map((r) => ({ start: r.scheduled_at as string, end: r.ends_at as string }))
}

/** Free slots for a (doctor, service) in a window. */
export async function getFreeSlots(
  supabase: SupabaseClient,
  accountId: string,
  args: {
    doctorId: string
    from: string
    to: string
    durationMinutes: number
    timezone: string
    stepMinutes?: number
    nowISO?: string
  },
) {
  const [{ data: doctor }, { data: availability }, { data: timeOff }] = await Promise.all([
    supabase
      .from('doctor_profiles')
      .select('id, is_active')
      .eq('account_id', accountId)
      .eq('id', args.doctorId)
      .maybeSingle(),
    supabase
      .from('doctor_availability')
      .select('day_of_week, start_time, end_time')
      .eq('account_id', accountId)
      .eq('doctor_id', args.doctorId),
    supabase
      .from('doctor_time_off')
      .select('starts_at, ends_at, is_extra_hours')
      .eq('account_id', accountId)
      .eq('doctor_id', args.doctorId)
      .lt('starts_at', args.to)
      .gt('ends_at', args.from),
  ])
  if (!doctor || doctor.is_active === false) return []

  const busy = await loadDoctorBusy(supabase, accountId, args.doctorId, args.from, args.to)

  return computeFreeSlots({
    timezone: args.timezone,
    from: args.from,
    to: args.to,
    durationMinutes: args.durationMinutes,
    stepMinutes: args.stepMinutes,
    availability: (availability ?? []).map((b) => ({
      day_of_week: b.day_of_week as number,
      start_time: (b.start_time as string).slice(0, 5),
      end_time: (b.end_time as string).slice(0, 5),
    })),
    timeOff: (timeOff ?? []).map((t) => ({
      starts_at: t.starts_at as string,
      ends_at: t.ends_at as string,
      is_extra_hours: t.is_extra_hours as boolean,
    })),
    busy,
    now: args.nowISO,
  })
}

async function resolveDuration(
  supabase: SupabaseClient,
  accountId: string,
  serviceId: string | null | undefined,
  explicit: number | null | undefined,
): Promise<number> {
  if (explicit && Number.isFinite(explicit) && explicit > 0) return Math.round(explicit)
  if (serviceId) {
    const { data } = await supabase
      .from('products')
      .select('duration_minutes')
      .eq('account_id', accountId)
      .eq('id', serviceId)
      .maybeSingle()
    const d = Number(data?.duration_minutes)
    if (Number.isFinite(d) && d > 0) return Math.round(d)
  }
  return 30
}

async function resolveServiceAmount(
  supabase: SupabaseClient,
  accountId: string,
  serviceId: string | null | undefined,
): Promise<number | null> {
  if (!serviceId) return null
  const { data } = await supabase
    .from('products')
    .select('price')
    .eq('account_id', accountId)
    .eq('id', serviceId)
    .maybeSingle()
  const p = Number(data?.price)
  return Number.isFinite(p) && p >= 0 ? p : null
}

/**
 * Create one appointment, or a recurring series sharing a
 * `recurrence_group_id`. Every instance is conflict-checked against the
 * doctor's calendar; the first conflicting instance aborts the whole
 * create (nothing is written).
 */
export async function createAppointment(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  input: CreateAppointmentInput,
): Promise<CreateResult | OpError> {
  if (!input.patient_id || !input.doctor_id) return fail('patient_id y doctor_id son obligatorios')
  const start = new Date(input.scheduled_at)
  if (Number.isNaN(start.getTime())) return fail('scheduled_at inválido')
  if (start.getTime() < Date.now() - 60_000) return fail('La cita no puede ser en el pasado')

  const durationMin = await resolveDuration(
    supabase,
    accountId,
    input.service_id,
    input.duration_minutes,
  )

  let instances: { start: string; end: string }[]
  let recurrenceGroupId: string | null = null
  if (input.recurrence) {
    if (
      !isRecurrenceFrequency(input.recurrence.frequency) ||
      !Number.isInteger(input.recurrence.count) ||
      input.recurrence.count < RECURRENCE_MIN_COUNT ||
      input.recurrence.count > RECURRENCE_MAX_COUNT
    ) {
      return fail('Configuración de repetición inválida')
    }
    instances = expandRecurrence(start.toISOString(), durationMin, input.recurrence)
    if (instances.length === 0) return fail('No se pudo expandir la serie de citas')
    recurrenceGroupId = crypto.randomUUID()
  } else {
    instances = [
      {
        start: start.toISOString(),
        end: new Date(start.getTime() + durationMin * 60_000).toISOString(),
      },
    ]
  }

  // conflict check across the full span
  const spanFrom = instances[0].start
  const spanTo = instances[instances.length - 1].end
  const busy = await loadDoctorBusy(supabase, accountId, input.doctor_id, spanFrom, spanTo)
  for (const inst of instances) {
    if (overlapsBusy(inst.start, inst.end, busy)) {
      return fail(`El doctor ya tiene una cita el ${inst.start.slice(0, 16).replace('T', ' ')}`, 409)
    }
  }

  const amount =
    input.amount != null && Number.isFinite(input.amount) && input.amount >= 0
      ? input.amount
      : await resolveServiceAmount(supabase, accountId, input.service_id)

  const confirmationStatus: ConfirmationStatus =
    input.needs_confirmation === false ? 'not_required' : 'pending'

  const rows = instances.map((inst) => ({
    account_id: accountId,
    patient_id: input.patient_id,
    doctor_id: input.doctor_id,
    service_id: input.service_id ?? null,
    conversation_id: input.conversation_id ?? null,
    scheduled_at: inst.start,
    ends_at: inst.end,
    status: 'SCHEDULED' as AppointmentStatus,
    confirmation_status: confirmationStatus,
    amount,
    notes: input.notes ?? null,
    recurrence_group_id: recurrenceGroupId,
    created_by: userId,
    updated_by: userId,
  }))

  const { data, error } = await supabase.from('appointments').insert(rows).select('id, scheduled_at')
  if (error) {
    if (error.code === '23514') return fail('Datos de la cita inválidos', 400)
    return fail(error.message, 500)
  }
  const created = data ?? []

  // creation history (best-effort)
  if (created.length > 0) {
    await supabase.from('appointment_history').insert(
      created.map((c) => ({
        account_id: accountId,
        appointment_id: c.id,
        previous_status: null,
        new_status: 'SCHEDULED' as AppointmentStatus,
        new_scheduled_at: c.scheduled_at,
        reason: 'created',
        changed_by: userId,
      })),
    )
  }

  return { ok: true, ids: created.map((c) => c.id as string), recurrence_group_id: recurrenceGroupId }
}

/** Change an appointment's status (with the transition rules) + write history. */
export async function transitionAppointment(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  appointmentId: string,
  next: AppointmentStatus,
  opts: { confirmation_status?: ConfirmationStatus; reason?: string | null } = {},
): Promise<{ ok: true; appointment: Record<string, unknown> } | OpError> {
  const { data: current, error: readErr } = await supabase
    .from('appointments')
    .select('id, status, confirmation_status, scheduled_at')
    .eq('account_id', accountId)
    .eq('id', appointmentId)
    .maybeSingle()
  if (readErr) return fail(readErr.message, 500)
  if (!current) return fail('Cita no encontrada', 404)

  const from = current.status as AppointmentStatus
  if (from === next && !opts.confirmation_status) {
    return { ok: true, appointment: current }
  }
  if (isTerminalAppointmentStatus(from)) {
    return fail('La cita ya está finalizada y no se puede cambiar', 409)
  }
  if (!canTransitionAppointment(from, next)) {
    return fail(`No se puede pasar de ${from} a ${next}`, 409)
  }

  const patch: Record<string, unknown> = { status: next, updated_by: userId }
  if (opts.confirmation_status) patch.confirmation_status = opts.confirmation_status

  const { data, error } = await supabase
    .from('appointments')
    .update(patch)
    .eq('account_id', accountId)
    .eq('id', appointmentId)
    .select('*')
    .maybeSingle()
  if (error) return fail(error.message, 500)
  if (!data) return fail('Cita no encontrada', 404)

  await supabase.from('appointment_history').insert({
    account_id: accountId,
    appointment_id: appointmentId,
    previous_status: from,
    new_status: next,
    reason: opts.reason ?? null,
    changed_by: userId,
  })

  return { ok: true, appointment: data }
}

/**
 * Move an appointment to a new time. Records the previous date in
 * `appointment_history`, resets it to SCHEDULED and re-opens the
 * confirmation cycle. Conflict-checked (excluding itself).
 */
export async function rescheduleAppointment(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  appointmentId: string,
  input: { scheduled_at: string; duration_minutes?: number | null; reason?: string | null },
): Promise<{ ok: true; appointment: Record<string, unknown> } | OpError> {
  const { data: current, error: readErr } = await supabase
    .from('appointments')
    .select('id, status, scheduled_at, ends_at, doctor_id, service_id, confirmation_status')
    .eq('account_id', accountId)
    .eq('id', appointmentId)
    .maybeSingle()
  if (readErr) return fail(readErr.message, 500)
  if (!current) return fail('Cita no encontrada', 404)
  if (isTerminalAppointmentStatus(current.status as AppointmentStatus)) {
    return fail('La cita ya está finalizada', 409)
  }

  const start = new Date(input.scheduled_at)
  if (Number.isNaN(start.getTime())) return fail('scheduled_at inválido')
  if (start.getTime() < Date.now() - 60_000) return fail('La nueva fecha no puede ser en el pasado')

  const prevMs =
    new Date(current.ends_at as string).getTime() - new Date(current.scheduled_at as string).getTime()
  const durationMin =
    input.duration_minutes && input.duration_minutes > 0
      ? Math.round(input.duration_minutes)
      : await resolveDuration(supabase, accountId, current.service_id as string | null, prevMs / 60_000)
  const end = new Date(start.getTime() + durationMin * 60_000)

  const busy = await loadDoctorBusy(
    supabase,
    accountId,
    current.doctor_id as string,
    start.toISOString(),
    end.toISOString(),
    appointmentId,
  )
  if (overlapsBusy(start.toISOString(), end.toISOString(), busy)) {
    return fail('El doctor ya tiene una cita en ese horario', 409)
  }

  const wasConfirmed = current.confirmation_status !== 'not_required'
  const { data, error } = await supabase
    .from('appointments')
    .update({
      scheduled_at: start.toISOString(),
      ends_at: end.toISOString(),
      status: 'SCHEDULED' as AppointmentStatus,
      confirmation_status: wasConfirmed ? 'pending' : 'not_required',
      updated_by: userId,
    })
    .eq('account_id', accountId)
    .eq('id', appointmentId)
    .select('*')
    .maybeSingle()
  if (error) return fail(error.message, 500)
  if (!data) return fail('Cita no encontrada', 404)

  await supabase.from('appointment_history').insert({
    account_id: accountId,
    appointment_id: appointmentId,
    previous_status: current.status as AppointmentStatus,
    new_status: 'SCHEDULED' as AppointmentStatus,
    previous_scheduled_at: current.scheduled_at as string,
    new_scheduled_at: start.toISOString(),
    reason: input.reason ?? 'rescheduled',
    changed_by: userId,
  })

  return { ok: true, appointment: data }
}

export interface ListAppointmentsFilters {
  fromISO?: string
  toISO?: string
  doctorId?: string
  serviceId?: string
  status?: AppointmentStatus
  search?: string
  limit?: number
}

/** List appointments with patient / doctor / service joined for the table. */
export async function listAppointments(
  supabase: SupabaseClient,
  accountId: string,
  f: ListAppointmentsFilters,
) {
  let q = supabase
    .from('appointments')
    .select(
      `id, scheduled_at, ends_at, status, confirmation_status, amount, notes, recurrence_group_id,
       doctor_id, service_id, patient_id,
       patient_profiles!inner(id, contacts!inner(name, phone, phone_normalized, email)),
       doctor_profiles(display_name, color),
       products(name)`,
    )
    .eq('account_id', accountId)
    .order('scheduled_at', { ascending: true })
    .limit(Math.min(Math.max(f.limit ?? 300, 1), 1000))

  if (f.fromISO) q = q.gte('scheduled_at', f.fromISO)
  if (f.toISO) q = q.lt('scheduled_at', f.toISO)
  if (f.doctorId) q = q.eq('doctor_id', f.doctorId)
  if (f.serviceId) q = q.eq('service_id', f.serviceId)
  if (f.status) q = q.eq('status', f.status)

  const { data, error } = await q
  if (error) throw error

  let rows = data ?? []
  const search = (f.search ?? '').trim().toLowerCase()
  if (search) {
    const digits = search.replace(/\D/g, '')
    rows = rows.filter((r) => {
      const c = (r as Record<string, unknown>).patient_profiles as
        | { contacts?: { name?: string; phone?: string; phone_normalized?: string; email?: string } }
        | undefined
      const ct = c?.contacts
      if (!ct) return false
      return (
        (ct.name ?? '').toLowerCase().includes(search) ||
        (ct.email ?? '').toLowerCase().includes(search) ||
        (!!digits && ((ct.phone_normalized ?? '') + (ct.phone ?? '')).replace(/\D/g, '').includes(digits))
      )
    })
  }
  return rows
}

export { ISO_DATE }
