import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { autoReplyScheduleForAccount, withinAiAttentionHours } from '@/lib/ai/auto-reply-schedule'
import { contactMutesAi } from '@/lib/ai/muted-contact'
import { teammateRepliedRecently, isBusinessAutoReply } from '@/lib/ai/human-reply'
import { attentionBody, type AttentionContext } from './attention-details'
import { isCourtesyClosing } from '@/lib/ai/reception-alert'
export { attentionBody } from './attention-details'

export function attentionNotificationId(accountId: string, messageId: string, userId: string): string {
  const hash = createHash('sha256').update(`hotel-attention:${accountId}:${messageId}:${userId}`).digest('hex')
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
}

/** Recent customer burst plus the preceding staff question. Never read an
 * image as proof of payment or use a months-old booking to invent a reason. */
export async function loadAttentionContext(db: SupabaseClient, accountId: string, conversationId: string): Promise<AttentionContext> {
  try {
    const { data, error } = await db.from('messages')
      .select('sender_type,content_type,content_text,created_at,conversations!inner(account_id)')
      .eq('conversation_id', conversationId).eq('conversations.account_id', accountId)
      .neq('content_type', 'internal_note').neq('status', 'failed')
      .order('created_at', { ascending: false }).limit(30)
    if (error || !Array.isArray(data)) return {}
    const index = data.findIndex(m => m.sender_type === 'customer')
    if (index < 0) return {}
    const at = Date.parse(data[index].created_at)
    const texts: string[] = []
    for (const m of data.slice(index)) {
      if (at - Date.parse(m.created_at) > 30 * 60_000) break
      if (m.sender_type !== 'customer') {
        if (!isBusinessAutoReply(m.content_text)) break
        continue
      }
      if (m.content_text?.trim()) texts.unshift(m.content_text.trim())
      else if (['image', 'document', 'audio', 'video'].includes(m.content_type)) texts.unshift('Archivo adjunto para revisión')
    }
    const staff = data.slice(index + 1).find(m => m.sender_type === 'agent' && m.content_text?.trim()
      && !/^\[.*\]$/.test(m.content_text.trim()) && !isBusinessAutoReply(m.content_text)
      && at - Date.parse(m.created_at) <= 24 * 60 * 60_000)
    return { customerText: texts.join(' '), staffText: staff?.content_text ?? null }
  } catch { return {} }
}

/** Outside AI hours, every customer inbound needs the hotel's response.
 * Stable IDs deduplicate webhook retries without silencing later requests. */
export async function notifyHotelStaffInbound(db: SupabaseClient, accountId: string, data: unknown): Promise<void> {
  try {
    if (!data || typeof data !== 'object') return
    const event = data as Record<string, unknown>
    // A "sí" can accept a quote or answer a staff question: do not drop it.
    if (typeof event.text === 'string' && isCourtesyClosing(event.text)) return
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
    const context = await loadAttentionContext(db, accountId, event.conversation_id)
    const body = attentionBody('Responder al cliente; la atención de esta conversación corresponde al hotel.', current, message, context)
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
