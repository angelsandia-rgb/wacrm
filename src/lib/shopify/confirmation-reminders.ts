import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/currency'
import { withinBusinessHours } from '@/lib/ai/followups'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { CONFIRM_STAGE_NAME, loadShopifyConfig, normalizeGtPhone, shopifyGraphql, updateOrderTags } from './api'
import { notifyCustomer } from './notify'

export const REMINDED_TAG = 'recordatorio-confirmacion'
export const UNCONFIRMED_TAG = 'sin-confirmar-24h'
const REMIND_AFTER_MS = 3 * 60 * 60_000
const ESCALATE_AFTER_MS = 24 * 60 * 60_000
const REMINDER_TEMPLATE = ['recordatorio_confirmacion'] // {{1}} name, {{2}} order

/** Pure: what a web COD order still "Por confirmar" needs now. */
export function confirmationStep(args: {
  waitingMs: number; tags: string[]; customerWroteSince: boolean
}): 'remind' | 'escalate' | null {
  const { waitingMs, tags, customerWroteSince } = args
  if (waitingMs >= ESCALATE_AFTER_MS && !tags.includes(UNCONFIRMED_TAG)) return 'escalate'
  if (waitingMs >= REMIND_AFTER_MS && !tags.includes(REMINDED_TAG) && !customerWroteSince) return 'remind'
  return null
}

/** Pure: the reminder text (inside the 24 h window). */
export function reminderText(firstName: string, orderName: string, total: string): string {
  return `Hola${firstName ? ` ${firstName}` : ''}, su pedido *${orderName}* (${total}) aún está pendiente de confirmación ` +
    `y no lo enviaremos hasta que nos confirme. ¿Lo confirmamos? Responda *SÍ*, o díganos si desea cambiar o cancelar algo.`
}

/**
 * Web cash-on-delivery orders waiting in "Por confirmar": one WhatsApp
 * reminder 3 h after the request when the customer hasn't written back
 * (8:00–20:00 local), and at 24 h an alert to the team to call or cancel
 * in Dropi. Shopify tags record each step, so it never repeats. Rides the
 * follow-ups cron.
 */
export async function runConfirmationReminderSweep(admin: SupabaseClient, now: Date = new Date()): Promise<{ reminded: number; escalated: number }> {
  const res = { reminded: 0, escalated: 0 }
  const { data: stages } = await admin.from('pipeline_stages').select('id').ilike('name', CONFIRM_STAGE_NAME)
  if (!stages?.length) return res
  const { data: deals } = await admin
    .from('deals').select('id, account_id, contact_id, title, value, currency, shopify_order_id, updated_at')
    .in('stage_id', stages.map((s) => s.id as string)).eq('status', 'open').like('shopify_order_id', 'gid://shopify/Order/%')
    .limit(100)
  for (const deal of deals ?? []) {
    const accountId = deal.account_id as string
    try {
      const since = deal.updated_at as string
      const waitingMs = now.getTime() - Date.parse(since)
      if (waitingMs < REMIND_AFTER_MS) continue
      const { data: account } = await admin.from('accounts').select('timezone').eq('id', accountId).maybeSingle()
      if (!withinBusinessHours(now, (account?.timezone as string) || 'America/Guatemala', 8, 20)) continue
      const cfg = await loadShopifyConfig(admin, accountId)
      if (!cfg) continue
      const { order } = await shopifyGraphql<{ order: { name: string; tags: string[]; cancelledAt: string | null } | null }>(
        cfg, `query($id: ID!) { order(id: $id) { name tags cancelledAt } }`, { id: deal.shopify_order_id },
      )
      if (!order || order.cancelledAt) continue

      const { data: contact } = await admin.from('contacts').select('phone, name').eq('id', deal.contact_id).eq('account_id', accountId).maybeSingle()
      if (!contact?.phone) continue
      const { conversationId } = await resolveConversationByPhone(admin, accountId, normalizeGtPhone(contact.phone as string), (contact.name as string | null) ?? null)
      const { data: inbound } = await admin.from('messages').select('id')
        .eq('conversation_id', conversationId).eq('sender_type', 'customer').gt('created_at', since).limit(1)
      const step = confirmationStep({ waitingMs, tags: order.tags, customerWroteSince: Boolean(inbound?.length) })
      if (!step) continue

      if (step === 'escalate') {
        await updateOrderTags(cfg, deal.shopify_order_id as string, [UNCONFIRMED_TAG], [])
        const { data: recipients } = await admin.from('profiles').select('user_id').eq('account_id', accountId).in('account_role', ['owner', 'admin'])
        if (recipients?.length) {
          await admin.from('notifications').insert(recipients.map((r) => ({
            account_id: accountId, user_id: r.user_id as string, type: 'ai_handoff', conversation_id: conversationId,
            title: `Pedido ${order.name} sin confirmar`,
            body: `⏰ El pedido ${order.name} lleva 24 h sin confirmar por WhatsApp. Llame al cliente o cancélelo en Dropi y en Shopify antes de que se despache.`,
          })))
        }
        res.escalated++
        continue
      }

      // Tag first: a failed tag write must never mean a second reminder later.
      await updateOrderTags(cfg, deal.shopify_order_id as string, [REMINDED_TAG], [])
      const firstName = String(contact.name ?? '').trim().split(/\s+/)[0] || ''
      const total = formatCurrency(Number(deal.value) || 0, (deal.currency as string) || 'GTQ')
      const sent = await notifyCustomer(admin, accountId, conversationId, reminderText(firstName, order.name, total),
        { names: REMINDER_TEMPLATE, params: [firstName || 'cliente', order.name] })
      if (sent) res.reminded++
      else console.warn(`[confirmation reminders] ${order.name} (account ${accountId}): outside 24h window and no approved template`)
    } catch (err) {
      console.error('[confirmation reminders] deal failed', deal.id, err instanceof Error ? err.message : err)
    }
  }
  return res
}
