import { createHash } from 'node:crypto'

/**
 * Meta Conversions API: a Purchase for an order Chat Sandía took over
 * WhatsApp. Those orders are created through the Shopify Admin API, so they
 * never pass the storefront checkout and the Shopify ↔ Meta app's pixel never
 * reports them. Matching is by hashed phone / name / city (no ctwa_clid:
 * Zernio doesn't forward ad referrals yet).
 */

const META_API_VERSION = 'v21.0'

export interface CapiOrder {
  /** Shopify order GID — also the dedup key (Shopify retries → same event_id). */
  id: string
  name: string
  total: number
  currency: string
  phone: string
  firstName?: string | null
  lastName?: string | null
  city?: string | null
  itemCount: number
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')
const norm = (v: string | null | undefined) =>
  (v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Pure: the CAPI event (PII hashed as Meta requires; empty fields left out). */
export function buildPurchaseEvent(order: CapiOrder, nowSeconds: number) {
  const phone = order.phone.replace(/\D/g, '')
  const hashed = (v: string) => (v ? [sha256(v)] : undefined)
  return {
    event_name: 'Purchase',
    event_time: nowSeconds,
    event_id: `chat-sandia-${order.id.split('/').pop()}`,
    action_source: 'chat',
    user_data: {
      ph: hashed(phone),
      external_id: hashed(phone),
      fn: hashed(norm(order.firstName)),
      ln: hashed(norm(order.lastName)),
      ct: hashed(norm(order.city)),
      country: hashed('gt'),
    },
    custom_data: {
      currency: order.currency,
      value: Number(order.total.toFixed(2)),
      order_id: order.name,
      num_items: order.itemCount,
    },
  }
}

export async function sendMetaPurchase(datasetId: string, token: string, order: CapiOrder): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${datasetId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data: [buildPurchaseEvent(order, Math.floor(Date.now() / 1000))] }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Meta CAPI ${res.status}: ${body.slice(0, 300)}`)
  }
}
