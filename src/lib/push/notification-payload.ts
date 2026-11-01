import type { PushPayload } from './send'
import { attentionBody, formalAttentionAction } from './attention-details'

interface NotificationRow {
  id: string
  type: string
  title: string
  body?: string | null
  conversation_id?: string | null
}

function compact(text: string, limit: number): string {
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > limit ? value.slice(0, limit - 1).trimEnd() + '\u2026' : value
}

/** Shared Spanish presentation for push, foreground alerts and stored historical rows. */
export function notificationDisplayText(row: NotificationRow, contactName?: string | null): { title: string; body: string } {
  if (row.type === 'conversation_assigned') {
    if (/^(?:Motivo: |Cliente necesita atención por: )/.test(row.body || '')) {
      const detail = notificationDisplayText({ ...row, type: 'ai_handoff' }, contactName)
      return { title: compact(contactName ? `Conversación asignada: ${contactName}` : row.title.startsWith('Conversación asignada: ') ? row.title : 'Conversación asignada', 80), body: detail.body }
    }
    const name = contactName || row.body?.match(/assigned you a conversation with\s+(.+)$/i)?.[1]
    return { title: 'Conversaci\u00f3n asignada', body: name ? `Cliente: ${name.trim()}.\nAbra el chat para darle seguimiento.` : 'Tiene una conversaci\u00f3n por atender. Abra el chat para darle seguimiento.' }
  }
  if (row.type === 'ai_key_invalid') return {
    title: 'La IA no puede responder',
    body: 'La clave de acceso de la IA fue rechazada. Revise la configuraci\u00f3n de IA y atienda las consultas pendientes.',
  }
  if (row.type === 'google_calendar_error') return {
    title: 'Google Calendar necesita reconexi\u00f3n',
    body: 'La IA no puede consultar el calendario ni agendar citas. Recon\u00e9ctelo en Configuraci\u00f3n \u2192 Google Calendar.',
  }
  if (row.type === 'google_sheets_error') return {
    title: 'Google Sheets necesita reconexi\u00f3n',
    body: 'No se pueden actualizar las hojas de c\u00e1lculo. Reconecte la cuenta en Configuraci\u00f3n \u2192 Google Sheets.',
  }
  if (row.type === 'task_due') return {
    title: row.title.startsWith('Tarea pendiente') ? row.title : `Tarea pendiente: ${row.title.replace(/^Task (?:due|overdue):?\s*/i, '')}`,
    body: row.body ? row.body.replace(/^Contact:/i, 'Contacto:') : 'Revise la tarea y dele seguimiento.',
  }
  if (row.type !== 'ai_handoff') return { title: 'Aviso del sistema', body: 'Hay una novedad pendiente de revisi\u00f3n. Abra el aviso para consultar el detalle.' }
  const body = row.body ?? ''
  if (body.startsWith('Motivo: ') || body.startsWith('Cliente necesita atención por: ') || body.startsWith('Acción: ')) {
    let detail = body.startsWith('Acción: ')
      ? attentionBody(body.split('\n\nContexto completo:\n')[1] || body,
        body.match(/^Solicitud: (.+)$/m)?.[1], body.match(/^Mensaje: «(.*)»$/m)?.[1])
      : body
    if (/^(?:Cliente necesita atención por|Motivo): una consulta pendiente que debe revisar el equipo\./.test(detail)) {
      detail = attentionBody(body.split('\n\nContexto completo:\n')[1] || body,
        body.match(/^Referencia registrada: (.+)$/m)?.[1], body.match(/^Último mensaje: «(.*)»$/m)?.[1],
        { customerText: body.match(/^Contexto del cliente: (.+)$/m)?.[1], staffText: body.match(/^Última indicación del hotel: (.+)$/m)?.[1] })
    }
    return {
      title: compact(contactName ? `Requiere atención: ${contactName}` : row.title.startsWith('Requiere atención') ? row.title : 'Requiere atención del hotel', 80),
      body: detail.split('\n\nContexto completo:')[0]
        .replace(/^Cliente necesita atención por: /, 'Motivo: ')
        .replace(/^Acción requerida: (.+)$/m, (_match, action: string) => `Acción requerida: ${formalAttentionAction(action)}`),
    }
  }
  const reason = body.match(/Motivo:\s*[\u201c"]([\s\S]*?)[\u201d"](?:\s|$)/i)?.[1]
  const last = body.match(/\u00daltimo mensaje del cliente:\s*[\u201c"]([\s\S]*?)[\u201d"]/i)?.[1]
  const detail = reason || last
  const extra = reason && last && reason !== last ? `\n\u00daltimo mensaje: \u00ab${last}\u00bb` : ''
  return {
    title: compact(`Requiere atenci\u00f3n${contactName ? ': ' + contactName : ' del equipo'}`, 80),
    body: detail ? `${reason ? 'Motivo registrado' : 'Mensaje del cliente'}: \u00ab${detail}\u00bb${extra}` : 'La IA dej\u00f3 esta consulta pendiente para el equipo. Abra el chat para revisar el motivo y continuar la atenci\u00f3n.',
  }
}

export function notificationPushPayload(row: NotificationRow, contactName?: string | null): PushPayload {
  const text = notificationDisplayText(row, contactName)
  const lines = text.body.split('\n')
  if ((row.type === 'ai_handoff' || row.type === 'conversation_assigned') && lines[0].startsWith('Motivo: ')) {
    const reason = compact(lines[0], 90)
    const action = compact((lines.find(l => l.startsWith('Acción requerida: ')) || '').replace('Acción requerida: ', 'Acción: '), 95)
    const reference = lines.find(l => l.startsWith('Referencia registrada: '))?.replace('Referencia registrada: ', 'Datos: ')
    const message = lines.find(l => l.startsWith('Último mensaje: '))
    const budget = 300 - reason.length - action.length - 3
    const refLimit = reference ? message ? Math.floor(budget * .6) : budget : 0
    const extra = [reference ? compact(reference, refLimit) : '', message ? compact(message, budget - refLimit - (reference ? 1 : 0)) : ''].filter(Boolean).join(' ')
    return { title: compact(text.title, 80), body: compact([reason, action, extra].filter(Boolean).join(' '), 300),
      url: row.conversation_id ? `/inbox?c=${row.conversation_id}` : '/notifications', tag: row.conversation_id ? `hotel-attention:${row.conversation_id}` : row.id }
  }
  const body = row.type === 'ai_handoff' && lines.length > 1
    ? `${compact(lines[0], 180)} ${compact(lines.slice(1).join(' '), 115)}`
    : compact(text.body, 300)
  return { title: compact(text.title, 80), body,
    url: row.conversation_id ? `/inbox?c=${row.conversation_id}` : '/notifications', tag: row.id }
}
