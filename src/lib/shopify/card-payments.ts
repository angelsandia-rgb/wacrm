import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { formatCurrency } from '@/lib/currency'
import { dispatchSystemAlert } from '@/lib/observability/alerts'
import { ORDER_TEMPLATES } from './notify'
import { enqueueOrderNotification, runOrderNotificationSweep } from './notification-jobs'
import {
  completePaidDraftOrder, getRecurrenteCheckout, loadShopifyConfig, normalizeGtPhone, pickPaidStage, type ShopifyConfig,
} from './api'

/** A card link that stays unpaid this long is no longer watched. */
const WATCH_DAYS = 7
/** How often an open link is read back from Recurrente. */
const RECHECK_MS = 30 * 60_000

export type PaidCheckoutResult = { completed: string } | { held: string } | { skipped: string }

/** Remember a payment link right after Recurrente created it, so it can be
 *  reconciled without its webhook. A failure here is loud, never silent:
 *  the link already exists and may be paid. */
export async function recordCardCheckout(db: SupabaseClient, accountId: string, row: {
  checkoutId: string; draftId: string; conversationId: string | null; amount: number; currency: string
}): Promise<void> {
  const { error } = await db.from('shopify_card_checkouts').upsert({
    account_id: accountId, checkout_id: row.checkoutId, draft_id: row.draftId, conversation_id: row.conversationId,
    amount: row.amount, currency: row.currency,
  }, { onConflict: 'account_id,checkout_id', ignoreDuplicates: true })
  if (error) {
    await dispatchSystemAlert({
      severity: 'critical', source: 'shopify_card_checkout', accountId,
      title: 'No se pudo registrar un link de pago con tarjeta: si se paga sin webhook, nadie lo verá',
      dedupKey: `shopify_card_checkout_unrecorded:${accountId}:${row.checkoutId}`,
      detail: { checkout_id: row.checkoutId, draft_id: row.draftId, error: error.message },
    })
  }
}

async function settle(db: SupabaseClient, accountId: string, checkoutId: string, patch: Record<string, unknown>) {
  const { error } = await db.from('shopify_card_checkouts').update({ ...patch, last_checked_at: new Date().toISOString() })
    .eq('account_id', accountId).eq('checkout_id', checkoutId)
  if (error) throw new Error(`Cannot record card checkout state: ${error.message}`)
}

/**
 * A Recurrente checkout reported (webhook) or found (reconciliation) as paid.
 * The payment state and the draft id are read back from Recurrente, never
 * taken from the caller. A paid chat draft becomes a PAID order — it then
 * reaches Dropify/Dropi with nothing to collect — the deal moves and the
 * customer is told. Only with "Crear pedidos reales" on, for a purchase still
 * open in the CRM and with stock at payment time; otherwise the payment is
 * held with an owner notice + critical alert (real money either way).
 * Idempotent: a second call reuses the completed order and its keyed notices.
 */
export async function processPaidCheckout(
  db: SupabaseClient, accountId: string, cfg: ShopifyConfig, checkoutId: string,
): Promise<PaidCheckoutResult> {
  const checkout = await getRecurrenteCheckout(cfg.recurrenteSecretKey!, checkoutId)
  const draftId = checkout.metadata?.shopify_order_id
  if (checkout.status !== 'paid' || typeof draftId !== 'string' || !draftId.startsWith('gid://shopify/DraftOrder/')) {
    return { skipped: 'not a paid chat order' }
  }
  const total = checkout.total_in_cents / 100
  // The purchase the draft belongs to, read before anything is released.
  // After a completion it points at the real order instead (retry path).
  const { data: draftDeal, error: draftDealError } = await db.from('deals')
    .select('id, status, contact_id').eq('account_id', accountId).eq('shopify_order_id', draftId).maybeSingle()
  if (draftDealError) throw draftDealError
  // Real money arrived but nothing is released: hold it for a person — never
  // drop it silently. The owner's notice is stored before returning (a failure
  // throws, so the webhook gets a 500 and Recurrente retries).
  const hold = async (reason: string): Promise<PaidCheckoutResult> => {
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
    // No owner/admin to tell: the critical platform alert above is the escalation.
    if (recipients?.length) {
      // No linked customer (unlinked draft): the notice still reaches the
      // owner, without a conversation and without inventing a customer.
      const conversationId = contact?.phone
        ? (await resolveConversationByPhone(db, accountId, normalizeGtPhone(contact.phone as string), (contact.name as string | null) ?? null)).conversationId
        : ''
      const eventKey = `${checkoutId}:payment-held`
      await enqueueOrderNotification(db, accountId, eventKey, {
        conversationId, text: '', template: null,
        staff: {
          userIds: recipients.map((r) => r.user_id as string),
          title: `Pago de ${amount} retenido`,
          body: `💳 Se cobraron ${amount} con tarjeta pero no se creó el pedido: ${reason}. Revise el cobro en Recurrente y el borrador en Shopify, y resuelva con el cliente (completar el pedido o reembolsar según su política).` +
            (conversationId ? '' : ` Sin cliente vinculado en el CRM. Referencias: cobro ${checkoutId}, borrador ${draftId}.`),
        },
      })
      await runOrderNotificationSweep(db, accountId, eventKey)
    }
    await settle(db, accountId, checkoutId, { status: 'held', note: reason.slice(0, 500), resolved_at: new Date().toISOString() })
    return { held: reason }
  }
  if (!cfg.ordersLive) return hold('la venta está pausada (Crear pedidos reales apagado)')
  const result = await completePaidDraftOrder(cfg, draftId, total, checkout.currency, draftDeal?.status === 'open')
  if ('held' in result) return hold(result.held)
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
  await settle(db, accountId, checkoutId, { status: 'completed', order_id: order.id, resolved_at: new Date().toISOString() })
  return { completed: order.id }
}

/** Pure: which recorded links are due to be read back from Recurrente. */
export function dueCardCheckouts<T extends { created_at: string; last_checked_at: string | null }>(rows: T[], now: Date): T[] {
  return rows.filter((r) => now.getTime() - Date.parse(r.created_at) <= WATCH_DAYS * 86_400_000
    && (!r.last_checked_at || now.getTime() - Date.parse(r.last_checked_at) >= RECHECK_MS))
}

/**
 * Independent of the webhook: every open card link of the last 7 days is
 * read back from Recurrente about every 30 min. A paid one goes through the
 * same path as the webhook (idempotent); an expired one is closed; a link
 * still unpaid after 7 days stops being watched.
 */
export async function runCardCheckoutReconciliation(db: SupabaseClient, now: Date = new Date()): Promise<{ checked: number; completed: number; held: number; failed: number }> {
  const res = { checked: 0, completed: 0, held: 0, failed: 0 }
  const { data, error } = await db.from('shopify_card_checkouts').select('account_id, checkout_id, created_at, last_checked_at')
    .eq('status', 'open').order('created_at').limit(200)
  if (error) throw new Error(`Cannot read card checkouts: ${error.message}`)
  const configs = new Map<string, ShopifyConfig | null>()
  for (const row of dueCardCheckouts(data ?? [], now)) {
    const accountId = row.account_id as string
    const checkoutId = row.checkout_id as string
    try {
      if (!configs.has(accountId)) configs.set(accountId, await loadShopifyConfig(db, accountId))
      const cfg = configs.get(accountId)
      if (!cfg?.recurrenteSecretKey) continue
      res.checked++
      const checkout = await getRecurrenteCheckout(cfg.recurrenteSecretKey, checkoutId)
      if (checkout.status === 'paid') {
        const out = await processPaidCheckout(db, accountId, cfg, checkoutId)
        if ('completed' in out) res.completed++
        else if ('held' in out) res.held++
        else await settle(db, accountId, checkoutId, { status: 'held', note: out.skipped, resolved_at: now.toISOString() })
      } else if (checkout.status === 'expired') {
        await settle(db, accountId, checkoutId, { status: 'expired', resolved_at: now.toISOString() })
      } else {
        await settle(db, accountId, checkoutId, {})
      }
    } catch (err) {
      res.failed++
      console.error(`[card checkouts] ${checkoutId} (account ${accountId}) failed:`, err instanceof Error ? err.message : err)
    }
  }
  if (res.failed) {
    await dispatchSystemAlert({
      severity: 'warning', source: 'shopify_card_checkout', dedupKey: 'shopify_card_checkout_reconcile', throttleMinutes: 6 * 60,
      title: `No se pudo verificar el estado de ${res.failed} link(s) de pago con tarjeta`,
      detail: { failed: res.failed, checked: res.checked },
    })
  }
  return res
}
