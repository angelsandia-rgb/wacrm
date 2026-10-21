import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { autoReplyScheduleForAccount, withinAiAttentionHours } from '@/lib/ai/auto-reply-schedule'
import { contactMutesAi } from '@/lib/ai/muted-contact'
import { isSimpleAcknowledgement } from '@/lib/ai/reception-alert'
import { teammateRepliedRecently } from '@/lib/ai/human-reply'

export function attentionNotificationId(accountId: string, messageId: string, userId: string): string {
  const hash = createHash('sha256').update(`hotel-attention:${accountId}:${messageId}:${userId}`).digest('hex')
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
}

/** Spanish, actionable presentation; keeps the complete context in the stored alert. */
export function attentionBody(summary: string, request?: string | null, lastMessage?: string | null): string {
  const last = lastMessage || summary.match(/Último mensaje del cliente:\s*[“"]([\s\S]*?)[”"]/i)?.[1]
  const reason = summary.match(/Motivo:\s*[“"]([\s\S]*?)[”"](?:\s|$)/i)?.[1]
  const first = summary.split('\n')[0].replace(/^[^\p{L}]+/u, '').replace(/^Pendiente de recepción\.\s*/i, '')
  const action = /completó y confirmó su solicitud/.test(summary)
    ? 'Confirmar disponibilidad y total; el huésped ya completó su solicitud.'
    : reason || first || 'Revisar la consulta y responder al cliente.'
  return [`Acción: ${action}`, request ? `Solicitud: ${request.replace(/^[-\s]+/, '').replace(/\s+/g, ' ').trim()}` : null,
    last ? `Mensaje: «${last.replace(/\s+/g, ' ').trim()}»` : null,
    'Seguimiento: máximo 2 horas en horario del hotel (8:00 a. m.–8:00 p. m.); de noche, al iniciar ese horario.',
    '', 'Contexto completo:', summary].filter(v => v !== null).join('\n')
}

/** Outside AI hours, every customer inbound needs the hotel's response.
 * Stable IDs deduplicate webhook retries without silencing later requests. */
export async function notifyHotelStaffInbound(db: SupabaseClient, accountId: string, data: unknown): Promise<void> {
  try {
    if (!data || typeof data !== 'object') return
    const event = data as Record<string, unknown>
    if (typeof event.text === 'string' && isSimpleAcknowledgement(event.text)) return
    if (typeof event.conversation_id !== 'string' || typeof event.contact_id !== 'string' || typeof event.whatsapp_message_id !== 'string') return
    const { data: account } = await db.from('accounts').select('industry_vertical, feature_flags, timezone, default_currency').eq('id', accountId).maybeSingle()
    if (account?.industry_vertical !== 'hotel') return
    const { data: conv } = await db.from('conversations').select('ai_autoreply_disabled, ai_context_reset_at, contacts(name, phone)').eq('id', event.conversation_id).eq('account_id', accountId).maybeSingle()
    if (!conv) return
    const { data: cfg } = await db.from('ai_configs').select('handoff_agent_id, auto_reply_enabled').eq('account_id', accountId).maybeSingle()
    if (cfg?.auto_reply_enabled !== false && !conv.ai_autoreply_disabled && withinAiAttentionHours(autoReplyScheduleForAccount(account))
      && !await teammateRepliedRecently(db, accountId, event.conversation_id, conv.ai_context_reset_at ?? null)) return
    if (await contactMutesAi(db, event.contact_id)) return
    const { data: profiles } = await db.from('profiles').select('user_id').eq('account_id', accountId).in('account_role', ['owner', 'admin', 'agent'])
    const selected = profiles?.filter(p => p.user_id === cfg?.handoff_agent_id)
    const targets = selected?.length ? selected : profiles ?? []
    if (!targets.length) return
    const contact = conv.contacts as unknown as { name?: string; phone?: string } | null
    const { current } = await import('@/lib/ai/known-context').then(m => m.loadActiveReservationsSummary(db, accountId, event.conversation_id as string, account.default_currency || 'GTQ'))
    const media: Record<string, string> = { image: 'imagen', audio: 'nota de voz', document: 'documento', video: 'video', location: 'ubicación', sticker: 'sticker' }
    const message = typeof event.text === 'string' && event.text.trim() ? event.text : `Archivo recibido: ${media[String(event.content_type)] || 'mensaje multimedia'}`
    const body = attentionBody('Responder al cliente; la atención de esta conversación corresponde al hotel.', current, message)
    const { error } = await db.from('notifications').upsert(targets.map(p => {
      const id = attentionNotificationId(accountId, event.whatsapp_message_id as string, p.user_id)
      return { id, account_id: accountId, user_id: p.user_id, type: 'ai_handoff', conversation_id: event.conversation_id,
        title: `Requiere atención: ${contact?.name || contact?.phone || 'Cliente'}`, body }
    }), { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw error
  } catch (error) {
    console.error('[hotel attention] inbound alert failed', accountId, error)
  }
}
