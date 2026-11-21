import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { loadShopifyConfig, verifySvixSignature } from '@/lib/shopify/api'
import { processPaidCheckout } from '@/lib/shopify/card-payments'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The checkout also offers bank transfer (payment_method_types card +
// bank_transfer + balance), which reports through its own event. Safe to
// widen: the payment state is always re-read from Recurrente below.
const PAID_EVENTS = new Set(['intent.succeeded', 'payment_intent.succeeded', 'bank_transfer_intent.succeeded'])

/**
 * Recurrente webhook (Settings → Shopify shows the URL, with `?account=`).
 * Svix-signed. The work is processPaidCheckout (src/lib/shopify/card-payments.ts),
 * shared with the reconciliation job that finds paid links whose webhook
 * never arrived.
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
    const result = await processPaidCheckout(db, accountId, cfg, checkoutId)
    if ('skipped' in result) return NextResponse.json({ ok: true, skipped: result.skipped })
    if ('held' in result) return NextResponse.json({ ok: true, held: result.held })
  } catch (err) {
    // 500 → Recurrente retries; the completed order is reused on retry.
    console.error(`[recurrente webhook] checkout ${checkoutId} (account ${accountId}) failed:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
