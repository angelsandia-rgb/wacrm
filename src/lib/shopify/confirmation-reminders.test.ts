import { describe, expect, it } from 'vitest'
import { confirmationStep, reminderText, REMINDED_TAG, UNCONFIRMED_TAG } from './confirmation-reminders'

const h = (n: number) => n * 3600_000

describe('confirmationStep', () => {
  it.each(['cliente-cancela', 'confirmado-whatsapp'])('does not remind or escalate %s orders', (tag) => {
    for (const hours of [3, 25]) {
      expect(confirmationStep({ waitingMs: h(hours), tags: [tag], customerWroteSince: false })).toBeNull()
    }
  })
  it('waits 3 hours, then reminds once', () => {
    expect(confirmationStep({ waitingMs: h(2), tags: ['por-confirmar'], customerWroteSince: false })).toBeNull()
    expect(confirmationStep({ waitingMs: h(3), tags: ['por-confirmar'], customerWroteSince: false })).toBe('remind')
    expect(confirmationStep({ waitingMs: h(5), tags: ['por-confirmar', REMINDED_TAG], customerWroteSince: false })).toBeNull()
  })
  it('does not remind a customer who already wrote back (Cesi is on it)', () => {
    expect(confirmationStep({ waitingMs: h(4), tags: [], customerWroteSince: true })).toBeNull()
  })
  it('alerts the team once at 24 hours, even if the customer wrote', () => {
    expect(confirmationStep({ waitingMs: h(24), tags: [REMINDED_TAG], customerWroteSince: true })).toBe('escalate')
    expect(confirmationStep({ waitingMs: h(30), tags: [REMINDED_TAG, UNCONFIRMED_TAG], customerWroteSince: false })).toBeNull()
  })
})

describe('reminderText', () => {
  it('names the order and asks for a SÍ', () => {
    expect(reminderText('Ana', '#1002', 'Q300')).toBe(
      'Hola Ana, su pedido *#1002* (Q300) aún está pendiente de confirmación y no lo enviaremos hasta que nos confirme. ' +
      '¿Lo confirmamos? Responda *SÍ*, o díganos si desea cambiar o cancelar algo.',
    )
  })
})
