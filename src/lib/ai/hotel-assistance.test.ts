import { describe, expect, it } from 'vitest'
import { shouldDeferHotelStaffFollowup, hasUnconfirmedStayDuration, hotelReceptionReason, hotelCurrentRequest, isHotelReceptionPending, isAlreadyHandedOffRequest } from './hotel-assistance'
import type { ChatMessage } from './types'
const user = (content: string): ChatMessage => ({ role: 'user', content })

describe('guest answers to Angela intake questions', () => {
  const question: ChatMessage = { role: 'assistant', content: 'Para 2 y 3 noches, ¿qué fecha de entrada tienen prevista? El hotel confirmará el total.', createdAt: '2026-10-22T05:18:00Z' }
  const answer = { ...user('Entrada 30 de diciembre'), createdAt: '2026-10-22T06:14:00Z' }
  it('accepts Joyce arrival date even when the pending-case context contains only that answer', () => {
    expect(shouldDeferHotelStaffFollowup([answer], true, [question, answer])).toBe(false)
    expect(shouldDeferHotelStaffFollowup([answer], true)).toBe(true)
  })
  it('recognizes the original comparison of totals as permitted price information', () => {
    expect(shouldDeferHotelStaffFollowup([user('Seriamos 2 adultos y 2 niños, 6 años y 9 años. Como nos quedaria el total para 3 noches Y para 2 noche')], true)).toBe(false)
  })
  it('does not treat an unsolicited new headcount as a price question just because it says total', () => {
    expect(shouldDeferHotelStaffFollowup([user('En total seremos 4 personas')], true)).toBe(true)
  })
  it.each([
    ['¿Cuántos adultos y qué edades tienen los niños?', '2 adultos, niños de 6 y 9 años'],
    ['¿Cuántas noches desea hospedarse?', 'Tres noches'],
    ['¿Qué habitación prefiere?', 'La Junior Suite'],
    ['¿Cuál es su nombre completo?', 'Joyce de González'],
  ])('continues the requested intake: %s', (ask, reply) => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: ask }, user(reply)]
    expect(shouldDeferHotelStaffFollowup(messages, true)).toBe(false)
  })
  it('does not borrow a staff question or an unrelated old bot question', () => {
    expect(shouldDeferHotelStaffFollowup([answer], true, [{ ...question, senderType: 'agent' }, answer])).toBe(true)
    expect(shouldDeferHotelStaffFollowup([answer], true, [{ ...question, content: '¿Desea fotos?' }, answer])).toBe(true)
    expect(shouldDeferHotelStaffFollowup([answer], true, [{ ...question, createdAt: '2026-10-19T05:18:00Z' }, answer])).toBe(true)
  })
  it.each(['Cambie mi reserva al 30 de diciembre', 'Entrada 30 de diciembre, quiero pagar el anticipo', 'Me confirma la disponibilidad?', 'Ya envié el comprobante'])('keeps operational requests with staff despite an intake question: %s', text => {
    expect(shouldDeferHotelStaffFollowup([user(text)], true, [question, user(text)])).toBe(true)
  })
})
describe('staff-owned hotel conversations', () => {
  it.each(['Mañana cancelado', 'No entiendo…', 'Somos 3 adultos y dos menores de 10 y 3 años', 'Me urge mi cotización, ya llené el formulario', 'Sí por favor', 'Tengo tarifa corporativa', 'Nos envía la cuenta para pagar'])('defers the operational follow-up: %s', (text) => {
    expect(shouldDeferHotelStaffFollowup([user(text)], true)).toBe(true)
  })
  it.each(['¿A qué hora es el desayuno?', '¿Tienen parqueo?', '¿Me envía fotos de la habitación?'])('still answers factual information: %s', (text) => {
    expect(shouldDeferHotelStaffFollowup([user(text)], true)).toBe(false)
  })
  it('allows a new Sunday-to-Monday inquiry when the previous stay is historical', () => {
    expect(shouldDeferHotelStaffFollowup([user('Hola'), user('Tiene disponibilidad en hospedaje de domingo a lunes?')], false)).toBe(false)
  })
  it('does not restart a live request when the guest asks availability', () => {
    expect(shouldDeferHotelStaffFollowup([user('¿Hay habitación para el domingo?')], true)).toBe(true)
  })
})
describe('explicit stay length', () => {
  it('does not infer Fanny’s checkout from her arrival date and guest count', () => {
    expect(hasUnconfirmedStayDuration([user('Estoy interesada en alojamiento para el domingo 18 de octubre'), user('Somos 3 adultos y 2 niños de 4 y 2 años')])).toBe(true)
  })
  it.each(['Hospedaje de domingo a lunes', 'Alojamiento del 18 al 19 de octubre', 'Hospedaje para el domingo 18, una noche', 'Entrada 18 de octubre, salida 19 de octubre'])('accepts explicit length: %s', (text) => {
    expect(hasUnconfirmedStayDuration([user(text)])).toBe(false)
  })
  it('accepts a guest confirmation to an explicit checkout question', () => {
    expect(hasUnconfirmedStayDuration([user('Hospedaje el domingo 18'), { role: 'assistant', content: '¿Entrada el 18 y salida el 19?' }, user('Sí')])).toBe(false)
  })
})

describe('silent reception routing', () => {
  it.each([
    'Buenas disculpe precio del hospedaje para 6 o 7 personas y un ni\u00f1o de 3 a\u00f1os para entrar el sabado 5 de diciembre y salir el 6',
    'Somos un grupo familiar de 8 personas, cuanto cuestan dos habitaciones?',
    'Quiero cotizar para 51 personas',
    'Room prices for 7 guests and a child, December 5 to 6',
  ])('keeps headcount-only lodging inquiries eligible: %s', text => {
    expect(hotelReceptionReason([user(text)])).toBeNull()
  })
  it.each(['Necesito tarifa grupal para 7 personas', 'Quiero cotizar para un grupo de 7 personas', 'Group rates for 8 guests', 'Precio para una excursion de 8 personas', 'Necesito precio corporativo para 7 personas'])('keeps negotiated group terms with reception: %s', text => {
    expect(hotelReceptionReason([user(text)])).toBeTruthy()
  })
  it.each(['Quiero cancelar mi reserva', 'Necesito un reembolso', 'Le envío mi comprobante', 'Me pasa el número de cuenta', 'Tengo un voucher', 'Soy tour operador, tengo tarifa especial', 'Necesito cambiar mi reserva', 'Ya completé el formulario', 'Mi cotización sigue pendiente', 'Cotización para una boda', 'Quiero cotizar para un grupo de 51 personas', 'Quiero hablar con una persona'])('routes the staff decision without a customer reply: %s', (text) => {
    expect(hotelReceptionReason([user(text)])).toBeTruthy()
  })
  it.each(['¿A qué hora es el desayuno?', '¿Cuál es su política de cancelación?', '¿Qué formas de pago aceptan?', '¿Cuánto vale la habitación?', 'Quiero reservar una habitación para hoy', 'Hospedaje de domingo a lunes', '¿Me manda fotos de la Suite Premium?'])('keeps ordinary information eligible: %s', (text) => {
    expect(hotelReceptionReason([user(text)])).toBeNull()
  })
})


describe('current topic after a reception handoff', () => {
  const handoffAt = '2026-10-14T15:00:00.000Z'
  it('does not replay an already handed-off customer message', () => {
    expect(isAlreadyHandedOffRequest([{...user('Precio para 7 personas'),createdAt:'2026-10-14T14:59:00Z'}],handoffAt)).toBe(true)
    expect(isAlreadyHandedOffRequest([{...user('Somos 6 adultos'),createdAt:'2026-10-14T15:01:00Z'}],handoffAt)).toBe(false)
    expect(isAlreadyHandedOffRequest([user('Somos 6 adultos')],handoffAt)).toBe(false)
  })
  it('separates a later informational question from an unanswered cancellation', () => {
    const messages = [ { ...user('Quiero cancelar mi reserva'), createdAt: '2026-10-14T14:59:00.000Z' }, { ...user('¿Tienen parqueo?'), createdAt: '2026-10-14T19:00:00.000Z' } ]
    expect(hotelReceptionReason(hotelCurrentRequest(messages, handoffAt))).toBeNull()
    expect(shouldDeferHotelStaffFollowup(hotelCurrentRequest(messages, handoffAt), true)).toBe(false)
  })
  it('keeps all new messages together so a mixed payment and information burst stays with staff', () => {
    const messages = [ { ...user('Quiero cancelar mi reserva'), createdAt: '2026-10-14T14:59:00.000Z' }, { ...user('Le envío mi comprobante'), createdAt: '2026-10-14T19:00:00.000Z' }, { ...user('¿Tienen parqueo?'), createdAt: '2026-10-14T19:00:10.000Z' } ]
    expect(hotelReceptionReason(hotelCurrentRequest(messages, handoffAt))).toBeTruthy()
  })
  it('does not discard the original pending request when no new message has arrived', () => {
    const messages = [{ ...user('Quiero cancelar mi reserva'), createdAt: '2026-10-14T14:59:00.000Z' }]
    expect(hotelReceptionReason(hotelCurrentRequest(messages, handoffAt))).toBeTruthy()
  })
  it('recognizes only the application pending marker, not a manual pause', () => {
    expect(isHotelReceptionPending('🤝 Pendiente de recepción. Un pago.')).toBe(true)
    expect(isHotelReceptionPending('🤖 Ana tomó el control de esta conversación manualmente y pausó la IA.')).toBe(false)
    expect(isHotelReceptionPending(null)).toBe(false)
  })
})


it('lets a separate later question resume after an unanswered operational follow-up', () => {
  const messages = [
    { ...user('Quiero cancelar mi reserva'), createdAt: '2026-10-14T14:59:00.000Z' },
    { ...user('Le envío el comprobante'), createdAt: '2026-10-14T18:00:00.000Z' },
    { ...user('¿Tienen parqueo?'), createdAt: '2026-10-14T19:00:00.000Z' },
  ]
  expect(hotelReceptionReason(hotelCurrentRequest(messages, '2026-10-14T15:00:00.000Z'))).toBeNull()
})


it.each([
  'Solo que según veo falta que me confirmen disponibilidad',
  'Ya estarán laborando para poder validar disponibilidad',
  'Ya no vamos a usar 1 habitación doble. La distribución quedará as?: 9 dobles y 4 sencillas',
  'Le comparto el menú de almuerzos para el grupo de hoy',
])('routes an unresolved operation before generating a polite non-answer: %s', (text) => {
  expect(hotelReceptionReason([user(text), user('Muchas gracias')])).toBeTruthy()
})

it.each(['?Tiene disponibilidad para el s?bado?', '?Me comparte el menú de almuerzos?', '?Cu?nto cuesta una habitación doble?'])('does not route a new ordinary inquiry to staff: %s', (text) => {
  expect(hotelReceptionReason([user(text)])).toBeNull()
})


it.each(['Preferiria 2 habitaciones con 1 cama, aunque depende del precio', 'Que tarifas de referencia tienen?', 'Cuanto cuestan dos habitaciones individuales?'])('answers ordinary price references after staff participation: %s', (text) => {
  expect(shouldDeferHotelStaffFollowup([user(text)], true)).toBe(false)
})
it.each(['Tengo una tarifa especial', 'Me confirma la disponibilidad?', 'Quiero pagar el anticipo'])('keeps staff decisions with reception despite reference-price eligibility: %s', (text) => {
  expect(shouldDeferHotelStaffFollowup([user(text)], true)).toBe(true)
})
