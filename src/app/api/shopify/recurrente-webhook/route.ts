import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { ORDER_TEMPLATES } from '@/lib/shopify/notify'
import { enqueueOrderNotification, runOrderNotificationSweep } from '@/lib/shopify/notification-jobs'
import { formatCurrency } from '@/lib/currency'
import { dispatchSystemAlert } from '@/lib/observability/alerts'
import {
  completePaidDraftOrder, getRecurrenteCheckout, loadShopifyConfig, normalizeGtPhone, pickPaidStage, verifySvixSignature,
} from '@/lib/shopify/api'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The checkout also offers bank transfer (payment_method_types card +
// bank_transfer + balance), which reports through its own event. Safe to
// widen: the payment state is always re-read from Recurrente below.
const PAID_EVENTS = new Set(['intent.succeeded', 'payment_intent.succeeded', 'bank_transfer_intent.succeeded'])

/**
 * Recurrente webhook (Settings → Shopify shows the URL, with `?account=`).
 * A paid card checkout from the chat completes its Shopify draft as a PAID
 * order — it then reaches Dropify/Dropi with nothing to collect — moves the
 * deal to the real order and tells the customer. Svix-signed; the payment
 * state and the draft id are read back from Recurrente, never from the body.
 * Only with "Crear pedidos reales" on, for a purchase still open in the CRM
 * and with stock at payment time: otherwise the draft stays a draft and the
 * payment is held with an owner notice + critical alert (real money either way).
 * Always 200 once authenticated, so Recurrente doesn't retry handled events.
 */
export async function POST(request: Request) {
  const raw = await request.text()
  const accountId = new URL(request.url).searchParams.get('account') ?? ''
  if (!UUID_RE.test(accountId)) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })

  const db = supabaseAdmin()
  let cfg
  try {
    cfg = await loadShopifyConfig(db, accountId)
  } catch (err) {
    // Shopify token refresh failed: 500 so Recurrente retries later.
    console.error(`[recurrente webhook] account ${accountId} shopify config:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Shopify unavailable' }, { status: 500 })
  }
  const ok = cfg?.recurrenteWebhookSecret && cfg.recurrenteSecretKey && verifySvixSignature(raw, {
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
  }, cfg.recurrenteWebhookSecret)
  if (!cfg || !ok) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })

  let event: { event_type?: string; checkout?: { id?: string } | null }
  try {
    event = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const checkoutId = event.checkout?.id
  if (!PAID_EVENTS.has(event.event_type ?? '') || !checkoutId) return NextResponse.json({ ok: true, skipped: 'event' })

  try {
    const checkout = await getRecurrenteCheckout(cfg.recurrenteSecretKey!, checkoutId)
    const draftId = checkout.metadata?.shopify_order_id
    if (checkout.status !== 'paid' || typeof draftId !== 'string' || !draftId.startsWith('gid://shopify/DraftOrder/')) {
      return NextResponse.json({ ok: true, skipped: 'not a paid chat order' })
    }
    const total = checkout.total_in_cents / 100
    // The purchase the draft belongs to, read before anything is released.
    // After a completion it points at the real order instead (retry path).
    const { data: draftDeal, error: draftDealError } = await db.from('deals')
      .select('id, status, contact_id').eq('account_id', accountId).eq('shopify_order_id', draftId).maybeSingle()
    if (draftDealError) throw draftDealError
    // Real money arrived but nothing is released: hold it for a person —
    // never drop it silently. The owner's notice is stored before the 200
    // (a failure here → 500 → Recurrente retries); the platform alert is extra.
    const hold = async (reason: string) => {
      const amount = formatCurrency(total, checkout.currency)
      await dispatchSystemAlert({
        severity: 'critical', source: 'shopify_payment_held', accountId,
        title: `Pago recibido y retenido sin pedido: ${reason}`,
        dedupKey: `shopify_payment_held:${accountId}:${checkoutId}`, throttleMinutes: 240,
        detail: { checkout_id: checkoutId, draft_id: draftId, amount: total, currency: checkout.currency,
          action: 'Revise el borrador en Shopify y el cobro en Recurrente. Complete el borrador como PAGADO o resuelva con el cliente según la política; no se liberó nada a Dropi.' },
      })
      const { data: contact, error: contactError } = draftDeal?.contact_id
        ? await db.from('contacts').select('phone, name').eq('id', draftDeal.contact_id).eq('account_id', accountId).maybeSingle()
        : { data: null, error: null }
      if (contactError) throw contactError
      const { data: recipients, error: recipientsError } = await db.from('profiles').select('user_id')
        .eq('account_id', accountId).in('account_role', ['owner', 'admin'])
      if (recipientsError) throw recipientsError
      // ponytail: no contact (unlinked draft) → only the platform alert above; add a conversation-less owner notice if that ever happens.
      if (contact?.phone && recipients?.length) {
        const { conversationId } = await resolveConversationByPhone(db, accountId, normalizeGtPhone(contact.phone as string), (contact.name as string | null) ?? null)
        const eventKey = `${checkoutId}:payment-held`
        await enqueueOrderNotification(db, accountId, eventKey, {
          conversationId, text: '', template: null,
          staff: {
            userIds: recipients.map((r) => r.user_id as string),
            title: `Pago de ${amount} retenido`,
            body: `💳 Se cobraron ${amount} con tarjeta pero no se creó el pedido: ${reason}. Revise el cobro en Recurrente y el borrador en Shopify, y resuelva con el cliente (completar el pedido o reembolsar según su política).`,
          },
        })
        await runOrderNotificationSweep(db, accountId, eventKey)
      }
      return NextResponse.json({ ok: true, held: reason })
    }
    if (!cfg.ordersLive) return await hold('la venta está pausada (Crear pedidos reales apagado)')
    const result = await completePaidDraftOrder(cfg, draftId, total, checkout.currency, draftDeal?.status === 'open')
    if ('held' in result) return await hold(result.held)
    const { order } = result

    const { data: deal, error: lookupError } = await db.from('deals')
      .select('id, contact_id, pipeline_id, stage_id').eq('account_id', accountId)
      .in('shopify_order_id', [draftId, order.id]).maybeSingle()
    if (lookupError) throw lookupError
    if (deal) {
      const { error } = await db.from('deals').update({ shopify_order_id: order.id }).eq('id', deal.id).eq('account_id', accountId)
      if (error) throw error
    }
    if (deal?.pipeline_id) {
      const { data: stages } = await db
        .from('pipeline_stages').select('id, name, position').eq('pipeline_id', deal.pipeline_id)
      const paid = pickPaidStage(stages ?? [], deal.stage_id ?? null)
      if (paid) {
        const { error } = await db.from('deals').update({ stage_id: paid.id }).eq('id', deal.id).eq('account_id', accountId)
        if (error) throw error
      }
    }
    const { data: contact } = deal?.contact_id
      ? await db.from('contacts').select('phone, name').eq('id', deal.contact_id).eq('account_id', accountId).maybeSingle()
      : { data: null }
    if (contact?.phone) {
      const { conversationId } = await resolveConversationByPhone(db, accountId, normalizeGtPhone(contact.phone as string), (contact.name as string | null) ?? null)
      const amount = formatCurrency(total, checkout.currency)
      const firstName = String(contact.name ?? '').trim().split(/\s+/)[0] || 'cliente'
      // Outside the 24 h window (paid a day later) the pago_confirmado template carries it.
      const eventKey = `${order.id}:paid`
      await enqueueOrderNotification(db, accountId, eventKey, {
        conversationId, text: `✅ Recibimos su pago de ${amount}. Su pedido quedó confirmado y ya lo preparamos para envío. ` +
          `Número de pedido: *${order.name}*. Para saber cómo va, basta con escribir por aquí.`,
        template: { names: ORDER_TEMPLATES.paid, params: [firstName, amount, order.name] },
      })
      await runOrderNotificationSweep(db, accountId, eventKey)
    }
  } catch (err) {
    // 500 → Recurrente retries; the completed order is reused on retry.
    console.error(`[recurrente webhook] checkout ${checkoutId} (account ${accountId}) failed:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
