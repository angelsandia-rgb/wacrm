import type { SupabaseClient } from '@supabase/supabase-js'
import { isWithinMessagingWindow } from '@/lib/messaging/window'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

/** Order WhatsApp templates (Casa Ceiba, submitted 2026-11-13). Each list is
 *  tried in order; the first one Meta approved is used. */
export const ORDER_TEMPLATES = {
  confirm: ['confirmar_pedido'], // {{1}} name, {{2}} order, {{3}} total
  paid: ['pago_confirmado'], // {{1}} name, {{2}} amount, {{3}} order
  shipped: ['pedido_en_camino', 'pedido_enviado'], // {{1}} name, {{2}} order, {{3}} tracking
  delivered: ['pedido_entregado'], // {{1}} name, {{2}} order
} as const

/** The first of `names` the account has APPROVED by Meta, or null. */
export async function firstApprovedTemplate(
  db: SupabaseClient, accountId: string, names: readonly string[],
): Promise<{ name: string; language: string } | null> {
  if (!names.length) return null
  const { data } = await db
    .from('message_templates').select('name, language')
    .eq('account_id', accountId).eq('status', 'APPROVED').in('name', [...names])
  const rows = (data ?? []) as { name: string; language: string }[]
  for (const name of names) {
    const row = rows.find((r) => r.name === name)
    if (row) return row
  }
  return null
}

/** Free-form text inside the 24 h window; outside it, the first approved
 *  template of `template.names` (a customer who never wrote, or wrote long
 *  ago). False when neither can reach them — never throws for that. */
export async function notifyCustomer(
  db: SupabaseClient, accountId: string, conversationId: string, text: string,
  template: { names: readonly string[]; params: string[] } | null,
): Promise<boolean> {
  if (await isWithinMessagingWindow(db, conversationId)) {
    await sendMessageToConversation(db, accountId, { conversationId, messageType: 'text', senderType: 'bot', contentText: text })
    return true
  }
  const approved = template ? await firstApprovedTemplate(db, accountId, template.names) : null
  if (!approved || !template) return false
  await sendMessageToConversation(db, accountId, {
    conversationId, messageType: 'template', senderType: 'bot',
    templateName: approved.name, templateLanguage: approved.language || 'es', templateParams: template.params,
  })
  return true
}
