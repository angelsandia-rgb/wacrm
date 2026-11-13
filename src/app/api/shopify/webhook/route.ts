import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { formatCurrency } from '@/lib/currency'
import {
  attachOrderToDeal, CONFIRM_STAGE_NAME, DELIVERED_STAGE_NAME, loadShopifyConfig, normalizeGtPhone, ORDER_TAG, pickForwardStage,
  SHIPPED_STAGE_NAME, TO_CONFIRM_TAG, trackingSentence, updateOrderTags, verifyShopifyHmac,
} from '@/lib/shopify/api'
import { notifyCustomer, ORDER_TEMPLATES } from '@/lib/shopify/notify'

interface ShopifyAddress {
  first_name?: string | null; name?: string | null; phone?: string | null
  address1?: string | null; address2?: string | null; city?: string | null
}
interface ShopifyOrderPayload {
  admin_graphql_api_id: string
  fulfillments?: (ShopifyFulfillmentPayload & { status?: string | null })[] | null
  name: string
  total_price: string
  currency: string
  tags?: string
  financial_status?: string | null
  line_items?: { title?: string | null; quantity?: number | null }[] | null
  phone?: string | null
  customer?: { first_name?: string | null; phone?: string | null } | null
  shipping_address?: ShopifyAddress | null
  billing_address?: ShopifyAddress | null
}
interface ShopifyFulfillmentPayload {
  order_id?: number
  name?: string | null
  shipment_status?: string | null
  tracking_company?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
}

const TRACKING_HINT = 'Para saber cómo va el pedido, basta con escribir por aquí.'

/**
 * Shopify webhooks (store Settings → Notifications → Webhooks, all pointing
 * here). The account is resolved from X-Shopify-Shop-Domain and the body is
 * HMAC-checked with that account's webhook secret or, failing that, its app
 * client secret. Always 200 once authenticated, so Shopify doesn't retry.
 *
 * - `orders/create`: web-store orders get a contact, a deal and a WhatsApp
 *   message with their order number. Orders Chat Sandía created itself (tag
 *   `chat-sandia`) are skipped — the chat already confirmed them.
 * - `orders/updated` (the admin's "Actualización de pedido" — Notifications
 *   offers no fulfillment topics) and, for app-registered webhooks,
 *   `fulfillments/create|update`: Dropify writes Dropi's shipment back as a
 *   Shopify fulfillment. The order's deal moves to "Enviado" / "Entregado"
 *   and the customer is told — only when the deal actually advances, so the
 *   many repeated updates never send twice.
 */
export async function POST(request: Request) {
  const raw = await request.text()
  const shop = request.headers.get('x-shopify-shop-domain')?.toLowerCase() ?? ''
  const db = supabaseAdmin()

  const { data: cfg } = await db
    .from('shopify_config')
    .select('account_id, user_id, webhook_secret, client_secret, confirmation_template_name, confirmation_template_language')
    .eq('shop_domain', shop)
    .maybeSingle()
  // Admin → Notifications webhooks are signed with the store's key (webhook_secret);
  // webhooks registered by a Dev Dashboard app with its client secret. Accept either.
  const hmac = request.headers.get('x-shopify-hmac-sha256')
  const keys = [cfg?.webhook_secret, cfg?.client_secret].filter((k): k is string => Boolean(k))
  if (!cfg || !keys.some((k) => verifyShopifyHmac(raw, hmac, decrypt(k)))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  const topic = request.headers.get('x-shopify-topic')
  if (!topic || !HANDLED_TOPICS.has(topic)) return NextResponse.json({ ok: true })

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const accountId = cfg.account_id as string
  if (topic === 'orders/create') {
    return handleOrderCreated(db, accountId, cfg, body as ShopifyOrderPayload)
  }
  if (topic === 'orders/updated' || topic === 'orders/fulfilled') {
    const order = body as ShopifyOrderPayload
    const fs = order.fulfillments ?? []
    const live = fs.filter((f) => f.status !== 'cancelled' && f.status !== 'failure')
    if (!live.length) return NextResponse.json({ ok: true, skipped: 'not shipped' })
    return handleShipping(db, accountId, {
      orderGid: order.admin_graphql_api_id, orderName: order.name,
      delivered: live.some((f) => f.shipment_status === 'delivered'),
      tracking: live.find((f) => f.tracking_number) ?? live[0],
    })
  }
  const f = body as ShopifyFulfillmentPayload
  const delivered = f.shipment_status === 'delivered'
  // A fulfillments/update only matters once the carrier marks it delivered.
  if (!f.order_id || (!delivered && topic !== 'fulfillments/create')) return NextResponse.json({ ok: true, skipped: 'no stage change' })
  return handleShipping(db, accountId, {
    // "#1001.1" is the fulfillment; the customer knows the order as "#1001".
    orderGid: `gid://shopify/Order/${f.order_id}`, orderName: (f.name ?? '').split('.')[0] || 'tu pedido',
    delivered, tracking: f,
  })
}

const HANDLED_TOPICS = new Set(['orders/create', 'orders/updated', 'orders/fulfilled', 'fulfillments/create', 'fulfillments/update'])

async function handleOrderCreated(
  db: SupabaseClient, accountId: string,
  cfg: { user_id: unknown; confirmation_template_name: unknown; confirmation_template_language: unknown },
  order: ShopifyOrderPayload,
) {
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
    const dealId = await attachOrderToDeal({
      db, accountId, userId: cfg.user_id as string, contactId, currency: order.currency,
      order: { id: order.admin_graphql_api_id, name: order.name, total },
    })
    const totalText = formatCurrency(total, order.currency)
    const templateName = cfg.confirmation_template_name as string | null
    // Web orders are cash on delivery (card goes through WhatsApp): the
    // customer confirms before it ships — most COD returns are orders
    // nobody confirmed. Cesi reads their answer (order-confirmation.ts).
    const cod = order.financial_status !== 'paid'
    const awaiting = cod && dealId ? await markAwaitingConfirmation(db, accountId, dealId, order.admin_graphql_api_id) : false
    const sent = await notifyCustomer(db, accountId, conversationId,
      awaiting
        ? confirmationRequest(order, firstName, totalText)
        : `¡Hola${firstName ? ` ${firstName}` : ''}! Recibimos su pedido *${order.name}* por ${totalText}. ` +
          `Ese es su número de pedido para darle seguimiento. ¿Nos confirma que los datos de entrega son correctos? ${TRACKING_HINT}`,
      // The confirmation request uses confirmar_pedido; the plain order-number
      // message keeps the account's own template (shopify_config).
      awaiting || templateName
        ? { names: awaiting ? ORDER_TEMPLATES.confirm : [templateName as string], params: [firstName || 'cliente', order.name, totalText] }
        : null)
    if (!sent) console.warn(`[shopify webhook] order ${order.name} (account ${accountId}): no confirmation template configured and no open 24h window, customer not notified`)
  } catch (err) {
    // Logged, not retried: a failed WhatsApp send must not make Shopify re-deliver
    // and open a second deal for the same order.
    console.error(`[shopify webhook] order ${order.name} (account ${accountId}) follow-up failed:`, err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ ok: true })
}

/** Pure: the WhatsApp message asking a web COD customer to confirm. */
function confirmationRequest(order: ShopifyOrderPayload, firstName: string, totalText: string): string {
  const items = (order.line_items ?? []).map((i) => `• ${i.quantity ?? 1} x ${i.title ?? 'Producto'}`).join('\n')
  const a = order.shipping_address
  const where = [a?.address1, a?.address2, a?.city].map((p) => (p ?? '').trim()).filter(Boolean).join(', ')
  return `¡Hola${firstName ? ` ${firstName}` : ''}! Recibimos su pedido *${order.name}*:\n${items ? `${items}\n` : ''}` +
    `Total: ${totalText}, pago contra entrega.${where ? `\nEntrega en: ${where}.` : ''}\n\n` +
    `¿Confirma su pedido? Responda *SÍ* y lo preparamos para envío. Si hay que corregir algo, díganos qué.`
}

/** Deal → "Por confirmar" (when the board has that stage) and the order
 *  tagged por-confirmar. False without the stage: the old flow applies. */
async function markAwaitingConfirmation(db: SupabaseClient, accountId: string, dealId: string, orderId: string): Promise<boolean> {
  const { data: deal } = await db.from('deals').select('pipeline_id').eq('id', dealId).eq('account_id', accountId).maybeSingle()
  if (!deal?.pipeline_id) return false
  const { data: stages } = await db.from('pipeline_stages').select('id, name').eq('pipeline_id', deal.pipeline_id)
  const stage = (stages ?? []).find((s) => String(s.name).trim().toLowerCase() === CONFIRM_STAGE_NAME.toLowerCase())
  if (!stage) return false
  await db.from('deals').update({ stage_id: stage.id }).eq('id', dealId).eq('account_id', accountId)
  try {
    const cfg = await loadShopifyConfig(db, accountId)
    if (cfg) await updateOrderTags(cfg, orderId, [TO_CONFIRM_TAG], [])
  } catch (err) {
    console.error(`[shopify webhook] ${orderId} por-confirmar tag failed:`, err instanceof Error ? err.message : err)
  }
  return true
}

async function handleShipping(
  db: SupabaseClient, accountId: string,
  ship: { orderGid: string; orderName: string; delivered: boolean; tracking: ShopifyFulfillmentPayload },
) {
  const { delivered, orderName } = ship
  const f = ship.tracking
  const stageName = delivered ? DELIVERED_STAGE_NAME : SHIPPED_STAGE_NAME

  const { data: deal } = await db
    .from('deals').select('id, contact_id, pipeline_id, stage_id')
    .eq('account_id', accountId).eq('shopify_order_id', ship.orderGid).maybeSingle()
  if (!deal?.pipeline_id) return NextResponse.json({ ok: true, skipped: 'no deal' })

  const { data: stages } = await db.from('pipeline_stages').select('id, name, position').eq('pipeline_id', deal.pipeline_id)
  const next = pickForwardStage(stages ?? [], (deal.stage_id as string | null) ?? null, stageName)
  if (!next) return NextResponse.json({ ok: true, skipped: 'already there' })
  await db.from('deals').update({ stage_id: next.id }).eq('id', deal.id).eq('account_id', accountId)

  try {
    const { data: contact } = await db
      .from('contacts').select('phone, name').eq('id', deal.contact_id).eq('account_id', accountId).maybeSingle()
    if (!contact?.phone) return NextResponse.json({ ok: true, skipped: 'no phone' })
    const { conversationId } = await resolveConversationByPhone(
      db, accountId, normalizeGtPhone(contact.phone as string), (contact.name as string | null) ?? null,
    )
    const firstName = String(contact.name ?? '').trim().split(/\s+/)[0] || 'cliente'
    const sent = delivered
      ? await notifyCustomer(db, accountId, conversationId,
          `📦 Su pedido ${orderName} fue entregado. ¡Gracias por su compra! Cualquier duda con el producto, nos escribe por aquí.`,
          { names: ORDER_TEMPLATES.delivered, params: [firstName, orderName] })
      : await notifyCustomer(db, accountId, conversationId,
          `🚚 Su pedido ${orderName} ya va en camino. ${trackingSentence(f)}`,
          { names: ORDER_TEMPLATES.shipped, params: [firstName, orderName, trackingSentence(f)] })
    if (!sent) console.warn(`[shopify webhook] ${orderName} (account ${accountId}) ${stageName}: outside 24h window, customer not notified`)
  } catch (err) {
    console.error(`[shopify webhook] shipping update for ${orderName} (account ${accountId}) notify failed:`, err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ ok: true })
}
