import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/currency'
import { withinBusinessHours } from '@/lib/ai/followups'
import { contactMutesAi } from '@/lib/ai/muted-contact'
import { isWithinMessagingWindow } from '@/lib/messaging/window'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { loadShopifyConfig, normalizeGtPhone, shopifyGraphql } from './api'

/** Approved WhatsApp template for customers outside the 24 h window.
 *  Params: {{1}} first name, {{2}} products, {{3}} checkout link. */
export const CART_TEMPLATE_NAME = 'carrito_abandonado'
const WAIT_MS = 60 * 60_000 // a reminder an hour after they stopped
const MAX_AGE_MS = 24 * 60 * 60_000 // and never for a day-old cart

export interface AbandonedCheckout {
  id: string
  updatedAt: string
  completedAt: string | null
  abandonedCheckoutUrl: string
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } }
  customer: { firstName: string | null; phone: string | null } | null
  shippingAddress: { firstName: string | null; phone: string | null } | null
  lineItems: { nodes: { title: string; quantity: number }[] }
}

/** Pure: the carts worth one WhatsApp reminder right now. */
export function dueCarts(carts: AbandonedCheckout[], now: Date): (AbandonedCheckout & { phone: string })[] {
  return carts.flatMap((c) => {
    const age = now.getTime() - Date.parse(c.updatedAt)
    const raw = c.shippingAddress?.phone || c.customer?.phone
    const phone = raw ? normalizeGtPhone(raw) : ''
    return !c.completedAt && phone && age >= WAIT_MS && age <= MAX_AGE_MS ? [{ ...c, phone }] : []
  })
}

/** Pure: the reminder text (inside the 24 h window). */
export function cartReminderText(c: AbandonedCheckout, storeName: string): string {
  const name = c.shippingAddress?.firstName || c.customer?.firstName || ''
  const items = c.lineItems.nodes.map((i) => `• ${i.quantity} x ${i.title}`).join('\n')
  const total = formatCurrency(Number(c.totalPriceSet.shopMoney.amount), c.totalPriceSet.shopMoney.currencyCode)
  return `¡Hola${name ? ` ${name}` : ''}! 😊 Vimos que dejó pendiente su pedido en ${storeName}:\n${items}\nTotal: ${total}.\n\n` +
    `Puede terminarlo aquí: ${c.abandonedCheckoutUrl}\nO si prefiere, se lo tomamos por aquí mismo. ¿Le ayudo con algo?`
}

const QUERY = `{ abandonedCheckouts(first: 25, reverse: true) { nodes {
  id updatedAt completedAt abandonedCheckoutUrl totalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName phone } shippingAddress { firstName phone } lineItems(first: 10) { nodes { title quantity } }
} } }`

/**
 * One WhatsApp reminder per abandoned Shopify checkout (customer left at
 * checkout with a phone), an hour after they stopped, 8:00–20:00 local.
 * Free text inside the 24 h window, else the approved template. Rides the
 * follow-ups cron. `shopify_cart_reminders` (migration 178) claims each
 * checkout before sending, so a double run never sends twice.
 */
export async function runAbandonedCartSweep(admin: SupabaseClient, now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const res = { sent: 0, failed: 0 }
  const { data: stores } = await admin.from('shopify_config').select('account_id, accounts(name, timezone)')
  for (const store of stores ?? []) {
    const accountId = store.account_id as string
    const account = (Array.isArray(store.accounts) ? store.accounts[0] : store.accounts) as { name?: string; timezone?: string } | null
    if (!withinBusinessHours(now, account?.timezone || 'America/Guatemala', 8, 20)) continue
    try {
      const cfg = await loadShopifyConfig(admin, accountId)
      if (!cfg) continue
      const data = await shopifyGraphql<{ abandonedCheckouts: { nodes: AbandonedCheckout[] } }>(cfg, QUERY)
      for (const cart of dueCarts(data.abandonedCheckouts.nodes, now)) {
        const { data: claimed } = await admin.from('shopify_cart_reminders')
          .upsert({ checkout_id: cart.id, account_id: accountId }, { onConflict: 'checkout_id', ignoreDuplicates: true })
          .select('checkout_id')
        if (!claimed?.length) continue
        let error: string | null = null
        let conversationId: string | null = null
        try {
          const firstName = cart.shippingAddress?.firstName || cart.customer?.firstName || ''
          const resolved = await resolveConversationByPhone(admin, accountId, cart.phone, firstName || null)
          conversationId = resolved.conversationId
          if (await contactMutesAi(admin, resolved.contactId)) {
            error = 'muted contact'
          } else if (await isWithinMessagingWindow(admin, conversationId)) {
            await sendMessageToConversation(admin, accountId, {
              conversationId, messageType: 'text', senderType: 'bot', contentText: cartReminderText(cart, account?.name || 'la tienda'),
            })
          } else {
            await sendMessageToConversation(admin, accountId, {
              conversationId, messageType: 'template', senderType: 'bot', templateName: CART_TEMPLATE_NAME, templateLanguage: 'es',
              templateParams: [firstName || 'cliente', cart.lineItems.nodes.map((i) => `${i.quantity} x ${i.title}`).join(', '), cart.abandonedCheckoutUrl],
            })
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
        await admin.from('shopify_cart_reminders').update({ conversation_id: conversationId, error }).eq('checkout_id', cart.id)
        if (error) res.failed++
        else res.sent++
      }
    } catch (err) {
      console.error('[abandoned carts] store sweep failed', accountId, err instanceof Error ? err.message : err)
    }
  }
  return res
}
