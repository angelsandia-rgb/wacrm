// ============================================================
// Clinic vertical — row shapes (migrations 122 + 123) and the small
// enums the app validates against. Kept together so the domain is one
// import; DB reads cast to these.
// ============================================================

import type { AppointmentStatus, ConfirmationStatus } from './appointment-status'

export type { AppointmentStatus, ConfirmationStatus }

/** Where a patient originally came from (`patient_profiles.source`). */
export const PATIENT_SOURCES = [
  'WHATSAPP',
  'FACEBOOK',
  'INSTAGRAM',
  'WEB',
  'GOOGLE',
  'REFERRAL',
  'PHONE',
  'OTHER',
] as const
export type PatientSource = (typeof PATIENT_SOURCES)[number]

export function isPatientSource(v: unknown): v is PatientSource {
  return typeof v === 'string' && (PATIENT_SOURCES as readonly string[]).includes(v)
}

export interface PatientProfile {
  id: string
  account_id: string
  contact_id: string
  source: PatientSource | null
  created_at: string
  updated_at: string
}

export interface DoctorProfile {
  id: string
  account_id: string
  user_id: string | null
  display_name: string
  specialty: string | null
  color: string | null
  is_active: boolean
  restrict_to_own: boolean
  created_at: string
  updated_at: string
}

export interface DoctorAvailabilityRow {
  id: string
  account_id: string
  doctor_id: string
  day_of_week: number // 0..6
  start_time: string // HH:MM[:SS]
  end_time: string
  created_at: string
}

export interface DoctorTimeOffRow {
  id: string
  account_id: string
  doctor_id: string
  starts_at: string
  ends_at: string
  reason: string | null
  is_extra_hours: boolean
  created_at: string
}

export interface Appointment {
  id: string
  account_id: string
  patient_id: string
  doctor_id: string
  service_id: string | null
  conversation_id: string | null
  scheduled_at: string
  ends_at: string
  status: AppointmentStatus
  confirmation_status: ConfirmationStatus
  amount: number | null
  notes: string | null
  google_event_id: string | null
  recurrence_group_id: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export interface AppointmentHistoryRow {
  id: string
  account_id: string
  appointment_id: string
  previous_status: AppointmentStatus | null
  new_status: AppointmentStatus | null
  previous_scheduled_at: string | null
  new_scheduled_at: string | null
  reason: string | null
  changed_by: string | null
  created_at: string
}

export interface Visit {
  id: string
  account_id: string
  patient_id: string
  appointment_id: string | null
  doctor_id: string | null
  service_id: string | null
  visit_date: string // yyyy-mm-dd
  amount: number | null
  notes: string | null
  observations: string | null
  follow_up_date: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export interface VisitNoteRevision {
  id: string
  account_id: string
  visit_id: string
  notes: string | null
  observations: string | null
  edited_by: string | null
  created_at: string
}

export interface NoteTemplate {
  id: string
  account_id: string
  name: string
  body: string
  created_by: string | null
  created_at: string
  updated_at: string
}

/** Recurrence for "repetir cita" (spec §8). Expansion happens app-side;
 *  every generated instance shares `recurrence_group_id`. */
export const RECURRENCE_FREQUENCIES = ['weekly', 'biweekly', 'monthly'] as const
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number]

export interface RecurrenceSpec {
  frequency: RecurrenceFrequency
  /** Total number of appointments including the first. 2..26. */
  count: number
}

export function isRecurrenceFrequency(v: unknown): v is RecurrenceFrequency {
  return typeof v === 'string' && (RECURRENCE_FREQUENCIES as readonly string[]).includes(v)
}
