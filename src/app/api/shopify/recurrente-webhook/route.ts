import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { formatCurrency } from '@/lib/currency'
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
 * Only with "Crear pedidos reales" on: in test mode drafts stay drafts.
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
  if (!cfg.ordersLive) return NextResponse.json({ ok: true, skipped: 'test mode' })

  try {
    const checkout = await getRecurrenteCheckout(cfg.recurrenteSecretKey!, checkoutId)
    const draftId = checkout.metadata?.shopify_order_id
    if (checkout.status !== 'paid' || typeof draftId !== 'string' || !draftId.startsWith('gid://shopify/DraftOrder/')) {
      return NextResponse.json({ ok: true, skipped: 'not a paid chat order' })
    }
    const total = checkout.total_in_cents / 100
    const order = await completePaidDraftOrder(cfg, draftId, total)
    if (!order) return NextResponse.json({ ok: true, skipped: 'already completed or amount mismatch' })

    const { data: deal } = await db
      .from('deals').update({ shopify_order_id: order.id })
      .eq('account_id', accountId).eq('shopify_order_id', draftId)
      .select('id, contact_id, pipeline_id, stage_id').maybeSingle()
    if (deal?.pipeline_id) {
      const { data: stages } = await db
        .from('pipeline_stages').select('id, name, position').eq('pipeline_id', deal.pipeline_id)
      const paid = pickPaidStage(stages ?? [], deal.stage_id ?? null)
      if (paid) await db.from('deals').update({ stage_id: paid.id }).eq('id', deal.id).eq('account_id', accountId)
    }
    const { data: contact } = deal?.contact_id
      ? await db.from('contacts').select('phone, name').eq('id', deal.contact_id).eq('account_id', accountId).maybeSingle()
      : { data: null }
    if (contact?.phone) {
      const { conversationId } = await resolveConversationByPhone(db, accountId, normalizeGtPhone(contact.phone as string), (contact.name as string | null) ?? null)
      await sendMessageToConversation(db, accountId, {
        conversationId, messageType: 'text', senderType: 'bot',
        contentText: `✅ Recibimos tu pago de ${formatCurrency(total, checkout.currency)}. Tu pedido ${order.name} quedó confirmado y ya lo preparamos para envío. ` +
          `${order.name} es tu número de pedido: cuando quieras saber cómo va, escríbenos por aquí.`,
      })
    }
  } catch (err) {
    // 500 → Recurrente retries; a completed draft is skipped on the retry.
    console.error(`[recurrente webhook] checkout ${checkoutId} (account ${accountId}) failed:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
