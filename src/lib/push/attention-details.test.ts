import { describe, expect, it } from 'vitest'
import { attentionBody, explainAttention } from './attention-details'
import { notificationDisplayText, notificationPushPayload } from './notification-payload'

describe('explanatory hotel handoff notifications', () => {
  it.each([
    ['Hoy se me quedó una almohada en la habitación 10; ¿me la pueden guardar?', 'objeto olvidado', 'Verificar si está resguardado'],
    ['Adjunto pago', 'comprobante de pago', 'Revisar el comprobante'],
    ['Quedó pendiente mi factura', 'facturación', 'datos fiscales'],
    ['Quiero pagar el anticipo', 'coordinación de un pago', 'medio de pago autorizado'],
    ['No me permitió el pago por una validación con el banco', 'dificultad para realizar el pago', 'alternativa de pago'],
    ['¿No hay manera de hacer los masajes juntos?', 'horarios de masaje', 'horarios disponibles'],
    ['No me cuadra: son 20 habitaciones por 300', 'diferencia en el precio', 'Revisar el cálculo'],
    ['Quiero cambiar las fechas de mi reserva', 'cambio solicitado', 'no darlo por realizado'],
    ['¿Cómo quedaría el total para 2 y 3 noches?', 'cálculo de precio', 'importes autorizados'],
    ['¿Me confirma la reserva?', 'confirmación de una solicitud', 'antes de confirmar'],
    ['No, aún no me reserve', 'no reservar todavía', 'Respetar su decisión'],
  ])('explains the actual customer request: %s', (last, reason, action) => {
    const detail = explainAttention('El cliente continúa una gestión pendiente.', last)
    expect(detail.reason).toContain(reason)
    expect(detail.action).toContain(action)
  })
  it('uses the receipt message before thanks instead of describing a photo as an action', () => {
    const body = attentionBody('Pendiente de recepción. Motivo: “(El cliente envió una foto.)”', null, 'Gracias', { customerText: 'Archivo adjunto para revisión Adjunto pago Gracias' })
    expect(body).toContain('Cliente necesita atención por: la verificación de un comprobante de pago.')
    expect(body).toContain('Acción requerida: Revisar el comprobante')
    expect(body).toContain('Último mensaje: «Gracias»')
  })
  it('uses the preceding hotel question for a short otherwise ambiguous answer', () => {
    const detail = explainAttention('Gestión pendiente.', '2 porfavor', { customerText: '2 porfavor', staffText: '¿Cómo desea su factura: una al final o dos?' })
    expect(detail.reason).toContain('facturación')
  })
  it('explains when the client supplies data asked for by the hotel', () => {
    const detail = explainAttention('Gestión pendiente.', 'Entrada 30 de diciembre', { staffText: '¿Qué fecha de entrada desea?' })
    expect(detail.reason).toContain('datos recibidos')
  })
  it('never claims an uncaptioned image is a payment receipt', () => {
    const detail = explainAttention('Pendiente de recepción. Motivo: “El cliente envió una foto.”', 'Archivo recibido: imagen')
    expect(detail.reason).toContain('archivo adjunto')
    expect(detail.reason).not.toContain('pago')
  })
  it('does not let an earlier payment question override a new explicit lost-item request', () => {
    const detail = explainAttention('Coordinar un pago.', 'Olvidé mi almohada en la habitación', { staffText: '¿Ya realizó el pago?' })
    expect(detail.reason).toContain('objeto olvidado')
  })
  it('keeps the full detail in the panel and a bounded actionable push opening the chat', () => {
    const body = attentionBody('El cliente solicita atención.', '- Junior Suite · 24–25 oct · 4 personas', '¿Me confirma la reserva?')
    const row = { id: 'n', type: 'ai_handoff', title: 'Requiere atención: Nicole', conversation_id: 'chat', body }
    expect(notificationDisplayText(row).body).toContain('Acción requerida: Verificar disponibilidad y total')
    expect(notificationDisplayText(row).body).toContain('Plazo: máximo 2 horas')
    expect(notificationDisplayText(row).body).not.toContain('Contexto completo:')
    const push = notificationPushPayload(row)
    expect(push.body).toContain('Motivo: la confirmación')
    expect(push.body).toContain('Acción:')
    expect(push.body!.length).toBeLessThanOrEqual(300)
    expect(push).toMatchObject({ url: '/inbox?c=chat', tag: 'hotel-attention:chat' })
  })
  it('does not truncate the essential motive/action behind a long guest quote', () => {
    const body = attentionBody('Gestión pendiente.', 'Junior Suite '.repeat(50), 'Adjunto pago ' + 'detalle '.repeat(100))
    const push = notificationPushPayload({ id: 'n', type: 'ai_handoff', title: 'Requiere atención: Cliente', body })
    expect(push.body).toContain('comprobante de pago')
    expect(push.body).toContain('Revisar el comprobante')
    expect(push.body!.length).toBeLessThanOrEqual(300)
  })
})
