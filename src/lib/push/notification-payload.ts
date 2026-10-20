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

/** Put the customer's actual question before internal handoff boilerplate. */
export function notificationPushPayload(row: NotificationRow, contactName?: string | null): PushPayload {
  const base = { url: row.conversation_id ? `/inbox?c=${row.conversation_id}` : '/notifications', tag: row.id }
  if (row.type !== 'ai_handoff') return { ...base, title: row.title || 'Chat Sand\u00eda', body: compact(row.body ?? '', 300) }
  const body = row.body ?? ''
  const reason = body.match(/Motivo:\s*[\u201c"]([\s\S]*?)[\u201d"](?:\s|$)/i)?.[1]
  const last = body.match(/\u00daltimo mensaje del cliente:\s*[\u201c"]([\s\S]*?)[\u201d"]/i)?.[1]
  const detail = reason || last || body.replace(/^[\s\S]*?(?:\n|$)/, '').trim() || body
  const extra = reason && last && reason !== last ? ` \u00daltimo mensaje: ${last}` : ''
  return {
    ...base,
    title: compact(`Requiere atenci\u00f3n${contactName ? ': ' + contactName : ' del equipo'}`, 80),
    body: compact(detail + extra, 300),
  }
}
