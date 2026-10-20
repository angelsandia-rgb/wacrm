import { describe, expect, it } from 'vitest'
import { notificationDisplayText, notificationPushPayload } from './notification-payload'

describe('notificationPushPayload', () => {
  it('puts the handoff question and contact before internal boilerplate', () => {
    const p = notificationPushPayload({ id: 'n1', type: 'ai_handoff', title: 'AI needs a human', conversation_id: 'c1',
      body: '\ud83e\udd1d Pendiente de recepci\u00f3n. El cliente contin\u00faa una gesti\u00f3n pendiente.\n\ud83e\udd16 La IA transfiri\u00f3 la conversaci\u00f3n sin responder. \u00daltimo mensaje del cliente: \u201c6000.00\u201d Motivo: \u201cNo me cuadra: son 20 habitaciones por 300 cada una\u201d' }, 'Beatriz')
    expect(p).toMatchObject({title: 'Requiere atenci\u00f3n: Beatriz', url: '/inbox?c=c1', tag: 'n1'})
    expect(p.body).toBe('Motivo registrado: \u00abNo me cuadra: son 20 habitaciones por 300 cada una\u00bb \u00daltimo mensaje: \u00ab6000.00\u00bb')
  })
  it('uses the latest message when no separate reason was recorded', () => {
    expect(notificationPushPayload({id:'n',type:'ai_handoff',title:'old',body:'La IA transfiri\u00f3. \u00daltimo mensaje del cliente: \u201cDeseo cambiar mis fechas\u201d'}).body).toBe('Mensaje del cliente: \u00abDeseo cambiar mis fechas\u00bb')
  })
  it('replaces old system boilerplate with Spanish and bounds long payloads', () => {
    expect(notificationPushPayload({id:'n',type:'ai_handoff',title:'AI needs a human',body:'The AI handed off'}).body).toContain('La IA dej\u00f3 esta consulta pendiente')
    const p=notificationPushPayload({id:'n',type:'task_due',title:'Tarea pendiente',body:'x'.repeat(400)})
    expect(p.title).toBe('Tarea pendiente');expect(p.body).toHaveLength(300);expect(p.url).toBe('/notifications')
  })
  it('renders historical assignment rows in Spanish without changing the contact name',()=>{
    const text=notificationDisplayText({id:'n',type:'conversation_assigned',title:'New conversation assigned',body:'Someone assigned you a conversation with Beatriz'});
    expect(text).toEqual({title:'Conversaci\u00f3n asignada',body:'Cliente: Beatriz.\nAbr\u00ed el chat para darle seguimiento.'});
  })
  it.each([
    ['ai_key_invalid','La IA no puede responder','configuraci\u00f3n de IA'],
    ['google_calendar_error','Google Calendar necesita reconexi\u00f3n','Configuraci\u00f3n'],
    ['google_sheets_error','Google Sheets necesita reconexi\u00f3n','Configuraci\u00f3n'],
    ['future_type','Aviso del sistema','revisi\u00f3n'],
  ])('uses Spanish templates for %s even when stored text is English',(type,title,body)=>{
    const text=notificationDisplayText({id:'n',type,title:'English system title',body:'English error detail'});
    expect(text.title).toBe(title);expect(text.body).toContain(body);expect(text.body).not.toContain('English');
  })
  it('retains user-authored task titles and literal customer amounts',()=>{
    expect(notificationDisplayText({id:'n',type:'task_due',title:'Task due: Revisar Q6,000',body:'Contact: Beatriz'})).toEqual({title:'Tarea pendiente: Revisar Q6,000',body:'Contacto: Beatriz'});
  })
  it('reserves room for the latest message when the reason is long',()=>{
    const body=`\u00daltimo mensaje del cliente: \u201c6000.00\u201d Motivo: \u201c${'cotizaci\u00f3n '.repeat(60)}\u201d`;
    const p=notificationPushPayload({id:'n',type:'ai_handoff',title:'old',body});
    expect(p.body).toContain('6000.00');expect(p.body!.length).toBeLessThanOrEqual(300);
    expect(notificationDisplayText({id:'n',type:'ai_handoff',title:'old',body}).body.length).toBeGreaterThan(300);
  })
})
