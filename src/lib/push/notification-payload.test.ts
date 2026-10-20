import { describe, expect, it } from 'vitest'
import { notificationPushPayload } from './notification-payload'

describe('notificationPushPayload', () => {
  it('puts the handoff question and contact before internal boilerplate', () => {
    const p = notificationPushPayload({ id: 'n1', type: 'ai_handoff', title: 'AI needs a human', conversation_id: 'c1',
      body: '\ud83e\udd1d Pendiente de recepci\u00f3n. El cliente contin\u00faa una gesti\u00f3n pendiente.\n\ud83e\udd16 La IA transfiri\u00f3 la conversaci\u00f3n sin responder. \u00daltimo mensaje del cliente: \u201c6000.00\u201d Motivo: \u201cNo me cuadra: son 20 habitaciones por 300 cada una\u201d' }, 'Beatriz')
    expect(p).toMatchObject({title: 'Requiere atenci\u00f3n: Beatriz', url: '/inbox?c=c1', tag: 'n1'})
    expect(p.body).toBe('No me cuadra: son 20 habitaciones por 300 cada una \u00daltimo mensaje: 6000.00')
  })
  it('uses the latest message when no separate reason was recorded', () => {
    expect(notificationPushPayload({id:'n',type:'ai_handoff',title:'old',body:'La IA transfiri\u00f3. \u00daltimo mensaje del cliente: \u201cDeseo cambiar mis fechas\u201d'}).body).toBe('Deseo cambiar mis fechas')
  })
  it('retains a plain reason, bounds long payloads and preserves other types', () => {
    expect(notificationPushPayload({id:'n',type:'ai_handoff',title:'old',body:'Revisar pago pendiente'}).body).toBe('Revisar pago pendiente')
    const p=notificationPushPayload({id:'n',type:'task_due',title:'Tarea pendiente',body:'x'.repeat(400)})
    expect(p.title).toBe('Tarea pendiente');expect(p.body).toHaveLength(300);expect(p.url).toBe('/notifications')
  })
})
