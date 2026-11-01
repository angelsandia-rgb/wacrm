import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { formatCurrency } from '@/lib/currency'
import { attachOrderToDeal, normalizeGtPhone, ORDER_TAG, verifyShopifyHmac } from '@/lib/shopify/api'

interface ShopifyAddress { first_name?: string | null; name?: string | null; phone?: string | null }
interface ShopifyOrderPayload {
  admin_graphql_api_id: string
  name: string
  total_price: string
  currency: string
  tags?: string
  phone?: string | null
  customer?: { first_name?: string | null; phone?: string | null } | null
  shipping_address?: ShopifyAddress | null
  billing_address?: ShopifyAddress | null
}

/**
 * Shopify `orders/create` (configured in the store's Settings →
 * Notifications → Webhooks). The account is resolved from
 * X-Shopify-Shop-Domain and the body is HMAC-checked with that
 * account's webhook secret. Web-store orders get a contact, a deal and
 * a WhatsApp confirmation; orders Chat Sandía created itself (tag
 * `chat-sandia`) are skipped — the chat already confirmed them.
 * Always 200 once authenticated, so Shopify doesn't retry a handled order.
 */
export async function POST(request: Request) {
  const raw = await request.text()
  const shop = request.headers.get('x-shopify-shop-domain')?.toLowerCase() ?? ''
  const db = supabaseAdmin()

  const { data: cfg } = await db
    .from('shopify_config')
    .select('account_id, user_id, webhook_secret, confirmation_template_name, confirmation_template_language')
    .eq('shop_domain', shop)
    .maybeSingle()
  if (!cfg?.webhook_secret || !verifyShopifyHmac(raw, request.headers.get('x-shopify-hmac-sha256'), decrypt(cfg.webhook_secret))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (request.headers.get('x-shopify-topic') !== 'orders/create') return NextResponse.json({ ok: true })

  let order: ShopifyOrderPayload
  try {
    order = JSON.parse(raw) as ShopifyOrderPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const accountId = cfg.account_id as string
  const tags = (order.tags ?? '').split(',').map((t) => t.trim())
  if (tags.includes(ORDER_TAG)) return NextResponse.json({ ok: true, skipped: 'chat-sandia order' })

  // Shopify retries on timeouts — a deal already carrying this order means it was handled.
  const { data: seen } = await db
    .from('deals').select('id').eq('account_id', accountId).eq('shopify_order_id', order.admin_graphql_api_id).maybeSingle()
  if (seen) return NextResponse.json({ ok: true, skipped: 'duplicate' })

  const rawPhone = order.phone || order.shipping_address?.phone || order.customer?.phone || order.billing_address?.phone
  const phone = rawPhone ? normalizeGtPhone(rawPhone) : ''
  if (!phone) {
    console.warn(`[shopify webhook] order ${order.name} (account ${accountId}) has no phone, nothing to confirm`)
    return NextResponse.json({ ok: true, skipped: 'no phone' })
  }
  const firstName = order.shipping_address?.first_name || order.customer?.first_name || ''
  const total = Number(order.total_price) || 0

  try {
    const { contactId, conversationId } = await resolveConversationByPhone(
      db, accountId, phone, order.shipping_address?.name || firstName || null,
    )
    await attachOrderToDeal({
      db, accountId, userId: cfg.user_id as string, contactId, currency: order.currency,
      order: { id: order.admin_graphql_api_id, name: order.name, total },
    })
    const totalText = formatCurrency(total, order.currency)
    // A brand-new web customer has no open 24h window, so only a template reaches them;
    // the text fallback only lands when they wrote to us recently.
    await sendMessageToConversation(db, accountId, cfg.confirmation_template_name
      ? {
          conversationId, messageType: 'template', senderType: 'bot',
          templateName: cfg.confirmation_template_name as string,
          templateLanguage: (cfg.confirmation_template_language as string) || 'es',
          templateParams: [firstName || 'cliente', order.name, totalText],
        }
      : {
          conversationId, messageType: 'text', senderType: 'bot',
          contentText: `¡Hola${firstName ? ` ${firstName}` : ''}! Recibimos tu pedido ${order.name} por ${totalText}. ¿Nos confirmas que los datos de entrega son correctos?`,
        })
  } catch (err) {
    // Logged, not retried: a failed WhatsApp send must not make Shopify re-deliver
    // and open a second deal for the same order.
    console.error(`[shopify webhook] order ${order.name} (account ${accountId}) follow-up failed:`, err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ ok: true })
}
