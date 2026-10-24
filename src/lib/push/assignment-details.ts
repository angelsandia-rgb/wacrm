import type { SupabaseClient } from '@supabase/supabase-js'
import { attentionBody } from './attention-details'

/** Shared by foreground, panel and background push. RLS applies in browsers;
 * explicit account scoping also protects the service-role fanout. */
export async function enrichAssignment<T extends { type: string; title?: string; body?: string | null; conversation_id?: string | null; account_id: string; created_at?: string }>(db: SupabaseClient, row: T): Promise<T> {
  if (row.type !== 'conversation_assigned' || !row.conversation_id || /^(?:Motivo: |Cliente necesita atención por: )/.test(row.body || '')) return row
  try {
    const { data: conversation, error } = await db.from('conversations')
      .select('id,contacts(name,phone)').eq('account_id', row.account_id).eq('id', row.conversation_id).maybeSingle()
    if (error || !conversation) return row
    const { data: messages, error: messageError } = await db.from('messages')
      .select('sender_type,content_type,content_text,created_at,conversations!inner(account_id)')
      .eq('conversation_id', row.conversation_id).eq('conversations.account_id', row.account_id)
      .neq('content_type', 'internal_note').neq('status', 'failed')
      .lte('created_at', row.created_at || new Date().toISOString())
      .order('created_at', { ascending: false }).limit(30)
    if (messageError || !messages?.length) return row
    const index = messages.findIndex(m => m.sender_type === 'customer')
    if (index < 0) return row
    const customer = messages[index]
    const text = customer.content_text?.trim() || `Archivo recibido: ${customer.content_type}`
    const burst: string[] = []
    for (const message of messages.slice(index)) {
      if (message.sender_type !== 'customer' || Date.parse(customer.created_at) - Date.parse(message.created_at) > 30 * 60_000) break
      burst.unshift(message.content_text?.trim() || `Archivo recibido: ${message.content_type}`)
    }
    const contact = conversation.contacts as unknown as { name?: string; phone?: string } | null
    const name = contact?.name || contact?.phone || row.body?.match(/assigned you a conversation with\s+(.+)$/i)?.[1]
    return { ...row, title: name ? `Conversación asignada: ${name}` : 'Conversación asignada', body: attentionBody('Conversación asignada al equipo del hotel.', null, text, { customerText: burst.join(' ') }) }
  } catch { return row }
}
