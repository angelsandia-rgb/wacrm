import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, fetchAllRowsIn } from '@/lib/supabase/fetch-all'
import type { DateWindow } from './types'
import { endExclusive } from './queries'

/** First-touch ad of a contact (`contacts.referral`: WhatsApp CTWA, IG/FB ads). */
export interface AdReferral {
  source?: string
  channel?: string
  ad_id?: string
  ad_name?: string
  campaign_name?: string
  headline?: string
}

export interface AdSalesRow {
  key: string
  ad: string
  campaign: string | null
  leads: number
  sales: number
  revenue: number
}

interface ContactRow { id: string; referral: AdReferral | null }
interface DealRow { id?: string; contact_id: string; status: string; value: number | null; shopify_order_id: string | null }

/** Only ad referrals count — a `ref` link or post button is not an ad. */
function adOf(r: AdReferral | null): { key: string; ad: string; campaign: string | null } | null {
  if (!r || r.source !== 'ADS') return null
  const ad = r.ad_name || r.headline || (r.ad_id ? `Anuncio ${r.ad_id}` : 'Anuncio sin identificar')
  return { key: r.ad_id || ad, ad, campaign: r.campaign_name ?? null }
}

/** A sale = a won deal or a Shopify order that wasn't lost (orders stay open until delivered). */
const isSale = (d: DealRow) => d.status === 'won' || (Boolean(d.shopify_order_id) && d.status !== 'lost')

/** Pure: leads, sales and revenue per ad, best sellers first. */
export function salesByAd(contacts: ContactRow[], deals: DealRow[]): AdSalesRow[] {
  const byContact = new Map<string, AdSalesRow>()
  const rows = new Map<string, AdSalesRow>()
  for (const c of contacts) {
    const a = adOf(c.referral)
    if (!a) continue
    const row = rows.get(a.key) ?? { ...a, leads: 0, sales: 0, revenue: 0 }
    row.leads++
    rows.set(a.key, row)
    byContact.set(c.id, row)
  }
  for (const d of deals) {
    const row = byContact.get(d.contact_id)
    if (!row || !isSale(d)) continue
    row.sales++
    row.revenue += Number(d.value) || 0
  }
  return [...rows.values()].sort((x, y) => y.revenue - x.revenue || y.sales - x.sales || y.leads - x.leads)
}

/** Contacts who arrived from an ad within `window`, and all their deals. RLS scopes the account. */
export async function loadAdSales(db: SupabaseClient, window: DateWindow): Promise<AdSalesRow[]> {
  const contacts = await fetchAllRows<ContactRow>(
    () => db.from('contacts').select('id, referral').not('referral', 'is', null)
      .gte('created_at', window.start.toISOString()).lt('created_at', endExclusive(window.end)),
    { label: 'kpis ad sales contacts' },
  )
  const ids = contacts.filter((c) => adOf(c.referral)).map((c) => c.id)
  if (!ids.length) return []
  const deals = await fetchAllRowsIn<DealRow & { id: string }>(ids, (chunk) =>
    db.from('deals').select('id, contact_id, status, value, shopify_order_id').in('contact_id', chunk),
  )
  return salesByAd(contacts, deals)
}
