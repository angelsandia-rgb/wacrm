import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchSystemAlert, resolveSystemAlert } from '@/lib/observability/alerts'
import { hasDropiSyncError, loadShopifyConfig, shopifyGraphql } from './api'

const WINDOW_DAYS = 7
/** Webhooks land in seconds; past this an order without a deal was missed. */
const MISSING_DEAL_MS = 30 * 60_000
/** A Dropi rejection a person had time to fix but did not. */
const REJECTED_MS = 6 * 3600_000
/** A live order Dropi never turned into a shipment. */
const NOT_SHIPPED_MS = 72 * 3600_000

export interface ShopOrder { id: string; name: string; tags: string[]; createdAt: string; cancelledAt: string | null; displayFulfillmentStatus: string }
export interface ReconcileFindings { missingDeal: string[]; dropiRejected: string[]; notShipped: string[] }

/** Pure: compare what Shopify says against what the CRM recorded. Detects
 *  events that never arrived (a lost webhook, a silent Dropi), not only
 *  retries of known ones. */
export function reconcileOrders(orders: ShopOrder[], dealOrderIds: Set<string>, now: Date): ReconcileFindings {
  const out: ReconcileFindings = { missingDeal: [], dropiRejected: [], notShipped: [] }
  for (const o of orders) {
    if (o.cancelledAt) continue
    const age = now.getTime() - Date.parse(o.createdAt)
    const unshipped = o.displayFulfillmentStatus === 'UNFULFILLED'
    if (!dealOrderIds.has(o.id) && age >= MISSING_DEAL_MS) out.missingDeal.push(o.name)
    if (unshipped && hasDropiSyncError(o.tags.join(','))) {
      if (age >= REJECTED_MS) out.dropiRejected.push(o.name)
    } else if (unshipped && age >= NOT_SHIPPED_MS) out.notShipped.push(o.name)
  }
  return out
}

/**
 * Hourly per connected store: last 7 days of Shopify orders vs CRM deals.
 * One platform alert per account listing what is off; resolves once clean.
 * Payments: Recurrente redelivers its webhooks for days (Svix), and a held
 * payment already alerts; a paid-but-lost checkout is not detected here.
 */
// ponytail: no Recurrente-side listing (checkout ids are not stored); store them if card volume grows.
export async function runShopifyReconciliation(db: SupabaseClient, now: Date = new Date()): Promise<{ accounts: number; flagged: number }> {
  const res = { accounts: 0, flagged: 0 }
  const { data: stores, error } = await db.from('shopify_config').select('account_id')
  if (error) throw new Error(`Cannot list stores: ${error.message}`)
  for (const { account_id: accountId } of stores ?? []) {
    try {
      const cfg = await loadShopifyConfig(db, accountId as string)
      if (!cfg) continue
      const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString()
      const { orders } = await shopifyGraphql<{ orders: { nodes: ShopOrder[] } }>(cfg,
        `query($q: String!) { orders(first: 100, query: $q, sortKey: CREATED_AT, reverse: true) {
          nodes { id name tags createdAt cancelledAt displayFulfillmentStatus } } }`, { q: `created_at:>='${since}'` })
      const ids = orders.nodes.map((o) => o.id)
      const { data: deals, error: dealError } = ids.length
        ? await db.from('deals').select('shopify_order_id').eq('account_id', accountId).in('shopify_order_id', ids)
        : { data: [], error: null }
      if (dealError) throw dealError
      const f = reconcileOrders(orders.nodes, new Set((deals ?? []).map((d) => d.shopify_order_id as string)), now)
      res.accounts++
      const dedupKey = `shopify_reconcile:${accountId}`
      if (!f.missingDeal.length && !f.dropiRejected.length && !f.notShipped.length) { await resolveSystemAlert(dedupKey); continue }
      res.flagged++
      await dispatchSystemAlert({
        severity: 'warning', source: 'shopify_reconcile', dedupKey, accountId: accountId as string, throttleMinutes: 12 * 60,
        title: `Conciliación de pedidos — ${[
          f.dropiRejected.length && `rechazados por Dropi sin resolver: ${f.dropiRejected.join(', ')}`,
          f.notShipped.length && `sin envío después de 72 h: ${f.notShipped.join(', ')}`,
          f.missingDeal.length && `sin registro en el CRM: ${f.missingDeal.join(', ')}`,
        ].filter(Boolean).join('; ')}`.slice(0, 300),
        detail: { ...f },
      })
    } catch (err) {
      console.error('[shopify reconcile] account failed', accountId, err instanceof Error ? err.message : err)
    }
  }
  return res
}
