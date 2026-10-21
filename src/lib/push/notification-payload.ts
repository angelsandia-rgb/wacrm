import type { PushPayload } from './send'

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
    const name = contactName || row.body?.match(/assigned you a conversation with\s+(.+)$/i)?.[1]
    return { title: 'Conversaci\u00f3n asignada', body: name ? `Cliente: ${name.trim()}.\nAbr\u00ed el chat para darle seguimiento.` : 'Ten\u00e9s una conversaci\u00f3n por atender. Abr\u00ed el chat para darle seguimiento.' }
  }
  if (row.type === 'ai_key_invalid') return {
    title: 'La IA no puede responder',
    body: 'La clave de acceso de la IA fue rechazada. Revis\u00e1 la configuraci\u00f3n de IA y atend\u00e9 las consultas pendientes.',
  }
  if (row.type === 'google_calendar_error') return {
    title: 'Google Calendar necesita reconexi\u00f3n',
    body: 'La IA no puede consultar el calendario ni agendar citas. Reconectalo en Configuraci\u00f3n \u2192 Google Calendar.',
  }
  if (row.type === 'google_sheets_error') return {
    title: 'Google Sheets necesita reconexi\u00f3n',
    body: 'No se pueden actualizar las hojas de c\u00e1lculo. Reconect\u00e1 la cuenta en Configuraci\u00f3n \u2192 Google Sheets.',
  }
  if (row.type === 'task_due') return {
    title: row.title.startsWith('Tarea pendiente') ? row.title : `Tarea pendiente: ${row.title.replace(/^Task (?:due|overdue):?\s*/i, '')}`,
    body: row.body ? row.body.replace(/^Contact:/i, 'Contacto:') : 'Revis\u00e1 la tarea y dale seguimiento.',
  }
  if (row.type !== 'ai_handoff') return { title: 'Aviso del sistema', body: 'Hay una novedad pendiente de revisi\u00f3n. Abr\u00ed el aviso para consultar el detalle.' }
  const body = row.body ?? ''
  if (body.startsWith('Acción: ')) {
    return {
      title: compact(contactName ? `Requiere atención: ${contactName}` : row.title.startsWith('Requiere atención') ? row.title : 'Requiere atención del hotel', 80),
      body: body.split('\n\nContexto completo:')[0],
    }
  }
  const reason = body.match(/Motivo:\s*[\u201c"]([\s\S]*?)[\u201d"](?:\s|$)/i)?.[1]
  const last = body.match(/\u00daltimo mensaje del cliente:\s*[\u201c"]([\s\S]*?)[\u201d"]/i)?.[1]
  const detail = reason || last
  const extra = reason && last && reason !== last ? `\n\u00daltimo mensaje: \u00ab${last}\u00bb` : ''
  return {
    title: compact(`Requiere atenci\u00f3n${contactName ? ': ' + contactName : ' del equipo'}`, 80),
    body: detail ? `${reason ? 'Motivo registrado' : 'Mensaje del cliente'}: \u00ab${detail}\u00bb${extra}` : 'La IA dej\u00f3 esta consulta pendiente para el equipo. Abr\u00ed el chat para revisar el motivo y continuar la atenci\u00f3n.',
  }
}

export function notificationPushPayload(row: NotificationRow, contactName?: string | null): PushPayload {
  const text = notificationDisplayText(row, contactName)
  const lines = text.body.split('\n')
  if (row.type === 'ai_handoff' && lines[0].startsWith('Acción: ')) {
    const action = compact(lines[0], 100)
    const request = lines.find(l => l.startsWith('Solicitud: '))
    const message = lines.find(l => l.startsWith('Mensaje: '))
    const detail = [request ? compact(request, message ? 105 : 195) : '', message ? compact(message, request ? 90 : 195) : ''].filter(Boolean).join(' ')
    return { title: compact(text.title, 80), body: compact([action, detail].filter(Boolean).join(' '), 300),
      url: row.conversation_id ? `/inbox?c=${row.conversation_id}` : '/notifications', tag: row.conversation_id ? `hotel-attention:${row.conversation_id}` : row.id }
  }
  const body = row.type === 'ai_handoff' && lines.length > 1
    ? `${compact(lines[0], 180)} ${compact(lines.slice(1).join(' '), 115)}`
    : compact(text.body, 300)
  return { title: compact(text.title, 80), body,
    url: row.conversation_id ? `/inbox?c=${row.conversation_id}` : '/notifications', tag: row.id }
}
