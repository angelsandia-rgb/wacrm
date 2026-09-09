import { describe, it, expect } from 'vitest'
import {
  confirmationWindow,
  isNoResponseDue,
  renderConfirmationMessage,
  renderFollowupMessage,
  humanWhen,
} from './reminders'

const NOW = new Date('2026-03-10T18:00:00.000Z') // GT 12:00
const TZ = 'America/Guatemala'

describe('confirmationWindow', () => {
  it('is roughly "tomorrow" — 18h..30h out', () => {
    const w = confirmationWindow(NOW)
    expect(w.from).toBe('2026-03-11T12:00:00.000Z')
    expect(w.to).toBe('2026-03-12T00:00:00.000Z')
  })
})

describe('isNoResponseDue', () => {
  it('true once the grace passed and the appointment is imminent/past', () => {
    expect(
      isNoResponseDue({
        reminderSentAt: '2026-03-10T00:00:00Z', // 18h before now
        scheduledAt: '2026-03-10T19:00:00Z', // 1h out
        now: NOW,
      }),
    ).toBe(true)
  })
  it('false when the reminder just went out', () => {
    expect(
      isNoResponseDue({
        reminderSentAt: '2026-03-10T16:00:00Z', // 2h ago
        scheduledAt: '2026-03-11T15:00:00Z',
        now: NOW,
      }),
    ).toBe(false)
  })
  it('false when no reminder was sent', () => {
    expect(isNoResponseDue({ reminderSentAt: null, scheduledAt: '2026-03-10T19:00:00Z', now: NOW })).toBe(false)
  })
  it('false when the appointment is still far off (reply could still come)', () => {
    expect(
      isNoResponseDue({
        reminderSentAt: '2026-03-09T00:00:00Z',
        scheduledAt: '2026-03-15T15:00:00Z',
        now: NOW,
      }),
    ).toBe(false)
  })
})

describe('message rendering', () => {
  it('confirmation uses the first name + doctor + time label', () => {
    expect(
      renderConfirmationMessage({ patientName: 'Carlos López', timeLabel: 'mañana a las 10:00 AM', doctorName: 'Dr. Pérez' }),
    ).toBe('Hola Carlos 👋 Te recordamos tu cita mañana a las 10:00 AM con Dr. Pérez. ¿Confirmas tu asistencia?')
  })
  it('confirmation degrades gracefully with no name / no doctor', () => {
    expect(renderConfirmationMessage({ patientName: null, timeLabel: 'hoy a las 3:00 PM', doctorName: null })).toBe(
      'Hola 👋 Te recordamos tu cita hoy a las 3:00 PM. ¿Confirmas tu asistencia?',
    )
  })
  it('follow-up mentions the doctor when known', () => {
    expect(renderFollowupMessage({ patientName: 'Ana', doctorName: 'Dra. Ruiz' })).toBe(
      'Hola Ana 👋 Dra. Ruiz recomendó realizar un seguimiento tras tu última visita. ¿Quieres que te muestre horarios disponibles?',
    )
  })
})

describe('humanWhen', () => {
  it('"mañana" / "hoy" / a dated label', () => {
    expect(humanWhen('2026-03-11T16:00:00Z', TZ, NOW)).toBe('mañana a las 10:00 AM')
    expect(humanWhen('2026-03-10T21:30:00Z', TZ, NOW)).toBe('hoy a las 3:30 PM')
    expect(humanWhen('2026-03-13T15:00:00Z', TZ, NOW)).toMatch(/^el .+ a las 9:00 AM$/)
  })
})
