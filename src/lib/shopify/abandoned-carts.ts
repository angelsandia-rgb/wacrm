import type { SupabaseClient } from '@supabase/supabase-js'
import { withinBusinessHours } from '@/lib/ai/followups'
import { contactMutesAi } from '@/lib/ai/muted-contact'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { loadShopifyConfig, shopifyGraphql } from './api'
import { CART_FIELDS, cartReminderText, cartTemplate, dueCarts, type AbandonedCheckout } from './abandoned-cart-data'
import { enqueueOrderNotification, runOrderNotificationSweep } from './notification-jobs'

export { CART_TEMPLATE_NAME, cartReminderText, dueCarts, type AbandonedCheckout } from './abandoned-cart-data'

/** New reminders use the durable queue. Legacy successes stay excluded;
 * failed legacy claims are eligible for recovery while the cart is recent. */
export async function runAbandonedCartSweep(admin: SupabaseClient, now: Date = new Date()): Promise<{ sent: number; failed: number; pending: number }> {
  const res = { sent: 0, failed: 0, pending: 0 }
  const { data: stores, error: storesError } = await admin.from('shopify_config').select('account_id, accounts(name, timezone)')
  if (storesError) throw storesError
  for (const store of stores ?? []) {
    const accountId = store.account_id as string
    const account = (Array.isArray(store.accounts) ? store.accounts[0] : store.accounts) as { name?: string; timezone?: string } | null
    if (!withinBusinessHours(now, account?.timezone || 'America/Guatemala', 8, 20)) continue
    try {
      const cfg = await loadShopifyConfig(admin, accountId)
      if (!cfg) continue
      const data = await shopifyGraphql<{ abandonedCheckouts: { nodes: AbandonedCheckout[] } }>(cfg,
        `{ abandonedCheckouts(first: 25, reverse: true) { nodes { ${CART_FIELDS} } } }`)
      for (const cart of dueCarts(data.abandonedCheckouts.nodes, now)) {
        try {
          const { data: legacy, error } = await admin.from('shopify_cart_reminders').select('checkout_id,error')
            .eq('account_id', accountId).eq('checkout_id', cart.id).maybeSingle()
          if (error) throw error
          if (legacy && !legacy.error) continue
          const firstName = cart.shippingAddress?.firstName || cart.customer?.firstName || ''
          const { contactId, conversationId } = await resolveConversationByPhone(admin, accountId, cart.phone, firstName || null)
          if (await contactMutesAi(admin, contactId)) continue
          const eventKey = `${cart.id}:cart`
          await enqueueOrderNotification(admin, accountId, eventKey, {
            conversationId, text: cartReminderText(cart, account?.name || 'la tienda'), template: cartTemplate(cart),
            cart: { checkoutId: cart.id, contactId, phone: cart.phone, storeName: account?.name || 'la tienda' },
          })
          const delivery = await runOrderNotificationSweep(admin, accountId, eventKey)
          res.sent += delivery.sent
          res.pending += delivery.pending
        } catch (err) {
          res.failed++
          console.error('[abandoned carts] cart failed', cart.id, err instanceof Error ? err.message : err)
        }
      }
    } catch (err) {
      res.failed++
      console.error('[abandoned carts] store sweep failed', accountId, err instanceof Error ? err.message : err)
    }
  }
  return res
}
