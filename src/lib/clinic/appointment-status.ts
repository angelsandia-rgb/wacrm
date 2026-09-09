// ============================================================
// Appointment status + confirmation — the single source of truth for
// the clinic vertical (migration 123's `appointment_status` enum).
//
// Pure, no I/O. API route guards and the UI both import from here so a
// status-policy change is a one-file diff, the same discipline as
// `src/lib/auth/roles.ts`.
// ============================================================

export const APPOINTMENT_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'DECLINED',
  'NO_RESPONSE',
  'RESCHEDULED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
] as const

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

export function isAppointmentStatus(v: unknown): v is AppointmentStatus {
  return typeof v === 'string' && (APPOINTMENT_STATUSES as readonly string[]).includes(v)
}

/** Spanish labels for the badge. */
export const APPOINTMENT_STATUS_LABEL_ES: Record<AppointmentStatus, string> = {
  SCHEDULED: 'Programada',
  CONFIRMED: 'Confirmada',
  DECLINED: 'No aceptada',
  NO_RESPONSE: 'Sin respuesta',
  RESCHEDULED: 'Reagendada',
  COMPLETED: 'Realizada',
  NO_SHOW: 'No Show',
  CANCELLED: 'Cancelada',
}

/** UI-agnostic tone for the badge — the component maps it to colours. */
export type StatusTone = 'neutral' | 'positive' | 'warning' | 'negative' | 'info'
export const APPOINTMENT_STATUS_TONE: Record<AppointmentStatus, StatusTone> = {
  SCHEDULED: 'neutral',
  CONFIRMED: 'positive',
  DECLINED: 'negative',
  NO_RESPONSE: 'warning',
  RESCHEDULED: 'info',
  COMPLETED: 'positive',
  NO_SHOW: 'negative',
  CANCELLED: 'neutral',
}

/** Once here, the appointment is done — no further status changes; a
 *  new visit means a new appointment. */
export const TERMINAL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
] as const

export function isTerminalAppointmentStatus(s: AppointmentStatus): boolean {
  return (TERMINAL_APPOINTMENT_STATUSES as readonly string[]).includes(s)
}

/**
 * Allowed manual status transitions. The reschedule *operation* is
 * separate (it moves `scheduled_at` and lands the row back on
 * `SCHEDULED` with a fresh confirmation cycle) — `RESCHEDULED` is kept
 * as an explicit settable state for teams that want to mark "the
 * patient asked to move this, pending a new time".
 */
export const ALLOWED_APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'DECLINED', 'NO_RESPONSE', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'],
  CONFIRMED: ['SCHEDULED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'],
  NO_RESPONSE: ['SCHEDULED', 'CONFIRMED', 'DECLINED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'],
  DECLINED: ['SCHEDULED', 'RESCHEDULED', 'CANCELLED'],
  RESCHEDULED: ['SCHEDULED', 'CONFIRMED', 'CANCELLED'],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
}

export function canTransitionAppointment(from: AppointmentStatus, to: AppointmentStatus): boolean {
  if (from === to) return true
  return (ALLOWED_APPOINTMENT_TRANSITIONS[from] as readonly string[]).includes(to)
}

// ── Confirmation lifecycle ─────────────────────────────────────

export const CONFIRMATION_STATUSES = [
  'not_required',
  'pending',
  'confirmed',
  'declined',
  'no_response',
] as const

export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number]

export function isConfirmationStatus(v: unknown): v is ConfirmationStatus {
  return typeof v === 'string' && (CONFIRMATION_STATUSES as readonly string[]).includes(v)
}

export const CONFIRMATION_STATUS_LABEL_ES: Record<ConfirmationStatus, string> = {
  not_required: 'No requiere',
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  declined: 'Rechazada',
  no_response: 'Sin respuesta',
}

/** KPI "tasa de confirmación" = confirmed / (every appointment whose
 *  confirmation was actually required). */
export function confirmationRequired(c: ConfirmationStatus): boolean {
  return c !== 'not_required'
}

export function isConfirmed(c: ConfirmationStatus): boolean {
  return c === 'confirmed'
}

/**
 * Map a patient's free-text/interpreted reply to a confirmation move.
 * The AI resolves the intent; this just pins the resulting pair of
 * (appointment status, confirmation status). `reschedule` is handled by
 * its own operation, not here.
 */
export type ConfirmationReply = 'confirm' | 'decline' | 'no_response'

export function applyConfirmationReply(reply: ConfirmationReply): {
  status: AppointmentStatus
  confirmation_status: ConfirmationStatus
} {
  switch (reply) {
    case 'confirm':
      return { status: 'CONFIRMED', confirmation_status: 'confirmed' }
    case 'decline':
      return { status: 'DECLINED', confirmation_status: 'declined' }
    case 'no_response':
      return { status: 'NO_RESPONSE', confirmation_status: 'no_response' }
  }
}
