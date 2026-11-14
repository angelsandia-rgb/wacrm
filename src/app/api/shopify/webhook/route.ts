import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { formatCurrency } from '@/lib/currency'
import { dispatchSystemAlert } from '@/lib/observability/alerts'
import {
  attachOrderToDeal, CONFIRM_STAGE_NAME, DELIVERED_STAGE_NAME, isCashOnDelivery, loadShopifyConfig, normalizeGtPhone, ORDER_TAG,
  orderFullyDelivered, pickForwardStage, hasDropiSyncError, dropiSyncReason, SHIPPED_STAGE_NAME, shopifyGraphql, TO_CONFIRM_TAG, trackingSentence, updateOrderTags,
  verifyShopifyHmac,
} from '@/lib/shopify/api'
import { ORDER_TEMPLATES } from '@/lib/shopify/notify'
import { enqueueOrderNotification, runOrderNotificationSweep } from '@/lib/shopify/notification-jobs'

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
  fulfillment_status?: string | null
  payment_gateway_names?: string[] | null
  cancelled_at?: string | null
  note?: string | null
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
 * client secret. Persistence failures return 500 for Shopify to retry;
 * WhatsApp failures remain in the durable notification queue.
 *
 * - `orders/create`: web-store orders get a contact, a deal and a WhatsApp
 *   message with their order number. Orders Chat Sandía created itself (tag
 *   `chat-sandia`) are skipped — the chat already confirmed them.
 * - `orders/updated` (the admin's "Actualización de pedido" — Notifications
 *   offers no fulfillment topics) and, for app-registered webhooks,
 *   `fulfillments/create|update`: Dropify writes Dropi's shipment back as a
 *   Shopify fulfillment. The order's deal moves to "Enviado" / "Entregado"
 *   and a tenant-scoped notification key deduplicates repeated updates.
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
  if (topic === 'orders/updated' || topic === 'orders/fulfilled' || topic === 'orders/cancelled') {
    const order = body as ShopifyOrderPayload
    if (order.cancelled_at) return handleCancelled(db, accountId, order.admin_graphql_api_id)
    const fs = order.fulfillments ?? []
    const live = fs.filter((f) => f.status !== 'cancelled' && f.status !== 'failure')
    // A stale tag on an order that is already shipping is no longer an exception.
    if (!live.length && hasDropiSyncError(order.tags)) return handleDropiSyncError(db, accountId, order)
    if (!hasDropiSyncError(order.tags)) {
      // The rejection was resolved: a later rejection of this order alerts again.
      const { error } = await db.from('shopify_notification_jobs').delete()
        .eq('account_id', accountId).like('event_key', `${order.admin_graphql_api_id}:dropi-sync-error%`)
      if (error) return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
    }
    if (!live.length) return NextResponse.json({ ok: true, skipped: 'not shipped' })
    return handleShipping(db, accountId, {
      orderGid: order.admin_graphql_api_id, orderName: order.name,
      delivered: orderFullyDelivered(fs, order.fulfillment_status),
      tracking: live.find((f) => f.tracking_number) ?? live[0],
    })
  }
  const f = body as ShopifyFulfillmentPayload
  const orderGid = `gid://shopify/Order/${f.order_id}`
  // One package's delivery says nothing about its siblings: the order itself
  // must be fully delivered. Unverifiable → keep it at "Enviado".
  const delivered = f.shipment_status === 'delivered' && await orderVerifiedDelivered(db, accountId, orderGid)
  // A fulfillments/update only matters once the carrier marks it delivered.
  if (!f.order_id || (!delivered && topic !== 'fulfillments/create')) return NextResponse.json({ ok: true, skipped: 'no stage change' })
  return handleShipping(db, accountId, {
    // "#1001.1" is the fulfillment; the customer knows the order as "#1001".
    orderGid, orderName: (f.name ?? '').split('.')[0] || 'tu pedido',
    delivered, tracking: f,
  })
}

const HANDLED_TOPICS = new Set(['orders/create', 'orders/updated', 'orders/fulfilled', 'orders/cancelled', 'fulfillments/create', 'fulfillments/update'])

/** Live read: every non-cancelled package delivered and nothing left to ship. */
async function orderVerifiedDelivered(db: SupabaseClient, accountId: string, orderGid: string): Promise<boolean> {
  try {
    const cfg = await loadShopifyConfig(db, accountId)
    if (!cfg) return false
    const { order } = await shopifyGraphql<{ order: { displayFulfillmentStatus: string; fulfillments: { status: string; displayStatus: string | null }[] } | null }>(
      cfg, 'query($id: ID!) { order(id: $id) { displayFulfillmentStatus fulfillments(first: 20) { status displayStatus } } }', { id: orderGid },
    )
    if (!order) return false
    return orderFullyDelivered(
      order.fulfillments.map((x) => ({ status: x.status.toLowerCase(), shipment_status: x.displayStatus?.toLowerCase() })),
      order.displayFulfillmentStatus,
    )
  } catch (err) {
    console.error(`[shopify webhook] cannot verify delivery of ${orderGid}:`, err instanceof Error ? err.message : err)
    return false
  }
}

/** The order did NOT reach Dropi: tell the owner/admins once, with Dropify's
 *  reason and the safe next step. The customer is not told anything: the
 *  fix (address data) and the re-send are a person's call. */
// One alert per order and reason: a different reason alerts again, and so does
// the same one once the tag was cleared (the cleared incident's key is deleted).
async function handleDropiSyncError(db: SupabaseClient, accountId: string, order: ShopifyOrderPayload) {
  try {
    const { data: deal, error: dealError } = await db.from('deals').select('contact_id')
      .eq('account_id', accountId).eq('shopify_order_id', order.admin_graphql_api_id).maybeSingle()
    if (dealError) throw dealError
    const { data: contact, error: contactError } = deal?.contact_id
      ? await db.from('contacts').select('phone, name').eq('id', deal.contact_id).eq('account_id', accountId).maybeSingle()
      : { data: null, error: null }
    if (contactError) throw contactError
    const rawPhone = (contact?.phone as string | undefined) || order.phone || order.shipping_address?.phone || ''
    const { data: recipients, error } = await db.from('profiles').select('user_id').eq('account_id', accountId).in('account_role', ['owner', 'admin'])
    if (error) throw error
    if (!rawPhone || !recipients?.length) {
      // No conversation to attach the in-app notice to: platform alert instead.
      await dispatchSystemAlert({
        severity: 'warning', source: 'dropi_sync_error', accountId,
        title: `Pedido ${order.name} no llegó a Dropi`, dedupKey: `dropi_sync_error:${accountId}:${order.admin_graphql_api_id}`,
        detail: { order: order.name, reason: dropiSyncReason(order.note) },
      })
      return NextResponse.json({ ok: true, alerted: 'system' })
    }
    const { conversationId } = await resolveConversationByPhone(
      db, accountId, normalizeGtPhone(rawPhone), (contact?.name as string | null) ?? order.shipping_address?.name ?? null,
    )
    const reason = dropiSyncReason(order.note) || 'Dropify no indicó el motivo'
    const eventKey = `${order.admin_graphql_api_id}:dropi-sync-error:${createHash('sha256').update(reason).digest('hex').slice(0, 12)}`
    await enqueueOrderNotification(db, accountId, eventKey, {
      conversationId, text: '', template: null,
      staff: {
        userIds: recipients.map((r) => r.user_id as string),
        title: `Pedido ${order.name} no llegó a Dropi`,
        body: `⚠️ Dropi rechazó el pedido ${order.name}: ${reason}. Corrija los datos en Shopify y reenvíelo desde Dropify, o cancélelo si ya no procede.`,
      },
    })
    await runOrderNotificationSweep(db, accountId, eventKey)
  } catch (err) {
    console.error(`[shopify webhook] dropi sync error notice for ${order.name} (account ${accountId}) failed:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

/** Cancelled in Shopify: the open deal closes as lost, which also stops the
 *  confirmation reminders. No customer message — whether Dropi already
 *  shipped is unknown here, and a cancellation is not a refund. */
async function handleCancelled(db: SupabaseClient, accountId: string, orderGid: string) {
  const { error } = await db.from('deals')
    .update({ status: 'lost', lost_reason: 'Pedido cancelado en Shopify', lost_at: new Date().toISOString() })
    .eq('account_id', accountId).eq('shopify_order_id', orderGid).eq('status', 'open')
  if (error) return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  return NextResponse.json({ ok: true })
}

async function handleOrderCreated(
  db: SupabaseClient, accountId: string,
  cfg: { user_id: unknown; confirmation_template_name: unknown; confirmation_template_language: unknown },
  order: ShopifyOrderPayload,
) {
  const tags = (order.tags ?? '').split(',').map((t) => t.trim())
  if (tags.includes(ORDER_TAG)) return NextResponse.json({ ok: true, skipped: 'chat-sandia order' })

  // Reuse the deal on retries; notification delivery has its own durable key.
  const { data: seen, error: seenError } = await db
    .from('deals').select('id, stage_id, pipeline_id').eq('account_id', accountId).eq('shopify_order_id', order.admin_graphql_api_id).maybeSingle()
  if (seenError) return NextResponse.json({ error: 'Order lookup failed' }, { status: 500 })

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
    const dealId = (seen?.id as string | undefined) ?? await attachOrderToDeal({
      db, accountId, userId: cfg.user_id as string, contactId, currency: order.currency,
      order: { id: order.admin_graphql_api_id, name: order.name, total },
    })
    const totalText = formatCurrency(total, order.currency)
    const templateName = cfg.confirmation_template_name as string | null
    // Cash-on-delivery web orders: the customer confirms before it ships —
    // most COD returns are orders nobody confirmed. Cesi reads their answer
    // (order-confirmation.ts). Decided by the payment gateway, not by
    // "not paid yet": a pending card/transfer order is no COD order.
    const cod = order.financial_status !== 'paid' && isCashOnDelivery(order.payment_gateway_names)
    // Never move an existing order backwards when Shopify redelivers creation.
    let awaiting = false
    if (cod && dealId && !seen) awaiting = await markAwaitingConfirmation(db, accountId, dealId, order.admin_graphql_api_id)
    if (cod && seen?.stage_id) {
      const { data: stage, error } = await db.from('pipeline_stages').select('name').eq('id', seen.stage_id).maybeSingle()
      if (error) throw error
      awaiting = String(stage?.name ?? '').trim().toLowerCase() === CONFIRM_STAGE_NAME.toLowerCase()
    }
    const eventKey = `${order.admin_graphql_api_id}:created`
    await enqueueOrderNotification(db, accountId, eventKey, {
      conversationId, text: awaiting
        ? confirmationRequest(order, firstName, totalText)
        : `¡Hola${firstName ? ` ${firstName}` : ''}! Recibimos su pedido *${order.name}* por ${totalText}. ` +
          `Ese es su número de pedido para darle seguimiento. ¿Nos confirma que los datos de entrega son correctos? ${TRACKING_HINT}`,
      // The confirmation request uses confirmar_pedido; the plain order-number
      // message keeps the account's own template (shopify_config).
      template: awaiting || templateName
        ? { names: awaiting ? ORDER_TEMPLATES.confirm : [templateName as string], params: [firstName || 'cliente', order.name, totalText] }
        : null,
      ...(awaiting ? { confirmation: { orderId: order.admin_graphql_api_id, contactId, since: new Date().toISOString(), reminder: false } } : {}),
    })
    await runOrderNotificationSweep(db, accountId, eventKey)
  } catch (err) {
    // Retry persistence failures; existing deals and queued events are reused.
    console.error(`[shopify webhook] order ${order.name} (account ${accountId}) follow-up failed:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
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
  const { error } = await db.from('deals').update({ stage_id: stage.id }).eq('id', dealId).eq('account_id', accountId)
  if (error) throw error
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

  try {
    const { data: contact, error: contactError } = await db
      .from('contacts').select('phone, name').eq('id', deal.contact_id).eq('account_id', accountId).maybeSingle()
    if (contactError) throw contactError
    if (!contact?.phone) {
      const { error } = await db.from('deals').update({ stage_id: next.id }).eq('id', deal.id).eq('account_id', accountId)
      if (error) throw error
      return NextResponse.json({ ok: true, skipped: 'no phone' })
    }
    const { conversationId } = await resolveConversationByPhone(
      db, accountId, normalizeGtPhone(contact.phone as string), (contact.name as string | null) ?? null,
    )
    const firstName = String(contact.name ?? '').trim().split(/\s+/)[0] || 'cliente'
    const eventKey = `${ship.orderGid}:${delivered ? 'delivered' : 'shipped'}`
    // Persist the message before advancing the deal, so retries cannot lose it.
    await enqueueOrderNotification(db, accountId, eventKey, {
      conversationId,
      text: delivered
        ? `📦 Su pedido ${orderName} fue entregado. ¡Gracias por su compra! Cualquier duda con el producto, nos escribe por aquí.`
        : `🚚 Su pedido ${orderName} ya va en camino. ${trackingSentence(f)}`,
      template: delivered
        ? { names: ORDER_TEMPLATES.delivered, params: [firstName, orderName] }
        : { names: ORDER_TEMPLATES.shipped, params: [firstName, orderName, trackingSentence(f)] },
    })
    const { error } = await db.from('deals').update({ stage_id: next.id }).eq('id', deal.id).eq('account_id', accountId)
    if (error) throw error
    await runOrderNotificationSweep(db, accountId, eventKey)
  } catch (err) {
    console.error(`[shopify webhook] shipping update for ${orderName} (account ${accountId}) notify failed:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
