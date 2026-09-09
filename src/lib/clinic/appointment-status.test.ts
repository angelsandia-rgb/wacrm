import { describe, it, expect } from 'vitest'
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL_ES,
  APPOINTMENT_STATUS_TONE,
  isAppointmentStatus,
  isTerminalAppointmentStatus,
  canTransitionAppointment,
  ALLOWED_APPOINTMENT_TRANSITIONS,
  CONFIRMATION_STATUSES,
  confirmationRequired,
  isConfirmed,
  applyConfirmationReply,
} from './appointment-status'

describe('appointment status registry', () => {
  it('every status has a Spanish label and a tone', () => {
    for (const s of APPOINTMENT_STATUSES) {
      expect(APPOINTMENT_STATUS_LABEL_ES[s]).toBeTruthy()
      expect(APPOINTMENT_STATUS_TONE[s]).toBeTruthy()
    }
  })

  it('isAppointmentStatus narrows', () => {
    expect(isAppointmentStatus('SCHEDULED')).toBe(true)
    expect(isAppointmentStatus('scheduled')).toBe(false)
    expect(isAppointmentStatus('WAITLIST')).toBe(false)
    expect(isAppointmentStatus(null)).toBe(false)
  })

  it('terminal states have no outgoing transitions', () => {
    for (const s of ['COMPLETED', 'NO_SHOW', 'CANCELLED'] as const) {
      expect(isTerminalAppointmentStatus(s)).toBe(true)
      expect(ALLOWED_APPOINTMENT_TRANSITIONS[s]).toEqual([])
      expect(canTransitionAppointment(s, 'SCHEDULED')).toBe(false)
    }
  })

  it('SCHEDULED can go anywhere sensible; a no-op transition is allowed', () => {
    expect(canTransitionAppointment('SCHEDULED', 'CONFIRMED')).toBe(true)
    expect(canTransitionAppointment('SCHEDULED', 'NO_SHOW')).toBe(true)
    expect(canTransitionAppointment('SCHEDULED', 'SCHEDULED')).toBe(true)
    expect(canTransitionAppointment('CONFIRMED', 'DECLINED')).toBe(false) // must go via SCHEDULED/NO_RESPONSE
  })

  it('transition targets are all real statuses', () => {
    for (const targets of Object.values(ALLOWED_APPOINTMENT_TRANSITIONS)) {
      for (const t of targets) expect(isAppointmentStatus(t)).toBe(true)
    }
  })
})

describe('confirmation lifecycle', () => {
  it('only not_required is exempt from the confirmation-rate denominator', () => {
    expect(confirmationRequired('not_required')).toBe(false)
    for (const c of CONFIRMATION_STATUSES.filter((x) => x !== 'not_required')) {
      expect(confirmationRequired(c)).toBe(true)
    }
  })

  it('isConfirmed is exactly "confirmed"', () => {
    expect(isConfirmed('confirmed')).toBe(true)
    expect(isConfirmed('pending')).toBe(false)
  })

  it('maps an interpreted reply to a status pair', () => {
    expect(applyConfirmationReply('confirm')).toEqual({ status: 'CONFIRMED', confirmation_status: 'confirmed' })
    expect(applyConfirmationReply('decline')).toEqual({ status: 'DECLINED', confirmation_status: 'declined' })
    expect(applyConfirmationReply('no_response')).toEqual({ status: 'NO_RESPONSE', confirmation_status: 'no_response' })
  })
})
