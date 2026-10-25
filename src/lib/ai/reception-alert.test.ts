import { describe, expect, it } from 'vitest'
import { hasNewReceptionRequest, latestCustomerTimestamp, isCourtesyClosing, isSimpleAcknowledgement } from './reception-alert'

describe('courtesy closings', () => {
  it.each(['Muy amable', 'Se lo agradezco', 'Muy bien Licenciada', 'Muchísimas gracias, buenas noches', 'Muchas gracias 🙏🏼🙏🏼', 'Gracias, le agradezco', 'Perfecto. Gracias yo les escribo en unos días'])('does not reopen or alert for %s', text => {
    expect(isCourtesyClosing(text)).toBe(true)
    expect(isSimpleAcknowledgement(text)).toBe(true)
  })
  it.each(['Sí', 'Perfecto', 'Gracias, ¿cuánto cuesta?', 'Ok gracias y no hay manera de hacer los masajes juntos?', 'Gracias, quedo pendiente de la factura', 'Muy bien, reserve por favor'])('preserves decisions and requests: %s', text => {
    expect(isCourtesyClosing(text)).toBe(false)
  })
})

describe('new reception requests', () => {
  it('notifies a new customer message even when a different operation was already pending', () => {
    expect(hasNewReceptionRequest('2026-10-20T02:00:00Z', '2026-10-20T02:05:00Z')).toBe(true)
  })
  it.each([null, 'invalid', '2026-10-20T01:59:00Z', '2026-10-20T02:00:00Z'])('does not replay stale/unknown inbound %s', at => {
    expect(hasNewReceptionRequest('2026-10-20T02:00:00Z', at)).toBe(false)
  })
  it('uses the last customer turn, not an assistant timestamp or an older message', () => {
    expect(latestCustomerTimestamp([{ role: 'user', content: 'Pago', createdAt: '2026-10-20T02:01:00Z' }, { role: 'assistant', content: 'Hola', createdAt: '2026-10-20T02:02:00Z' }])).toBe('2026-10-20T02:01:00Z')
    expect(latestCustomerTimestamp([{ role: 'user', content: 'Hola' }])).toBeNull()
  })
})
