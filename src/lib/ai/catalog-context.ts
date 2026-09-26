import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/currency'
import { formatDateEs, summarizeRates, type DayOfWeek } from '@/lib/products/rates'

// Bounds how much of the catalog reaches the prompt — plenty for a
// small/medium product list, keeps token spend predictable for
// accounts with a large one.
const MAX_PRODUCTS_IN_PROMPT = 30
const MAX_DESCRIPTION_CHARS = 80

/**
 * Compact, prompt-ready lines describing the account's active catalog
 * (name, price, short description), so the model can recommend and
 * quote real products by name instead of guessing. Returns null when
 * the account has no active products — callers should simply omit the
 * catalog section from the prompt in that case.
 */
interface CatalogProductRow {
  id: string
  name: string
  price: number
  description: string | null
}

interface RateRow {
  product_id: string
  day_of_week: DayOfWeek
  occupancy: 'standard' | 'couple' | 'group' | 'quad' | 'child'
  price: number
  date_from: string | null
  date_to: string | null
}

export async function loadCatalogContext(
  db: SupabaseClient,
  accountId: string,
): Promise<string[] | null> {
  const [{ data: products }, { data: account }] = await Promise.all([
    db
      .from('products')
      .select('id, name, price, description')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .order('name')
      .limit(MAX_PRODUCTS_IN_PROMPT),
    db
      .from('accounts')
      .select('default_currency, industry_vertical')
      .eq('id', accountId)
      .maybeSingle(),
  ])
  if (!products || products.length === 0) return null

  const currency = (account?.default_currency as string | undefined) ?? 'USD'
  const typed = products as CatalogProductRow[]

  // Hotel vertical: show each room's per-date rate structure (migration
  // 106) instead of just the base price, so the model can inform
  // tariffs and compute a stay correctly.
  let ratesByProduct = new Map<string, RateRow[]>()
  const maxGuestsByProduct = new Map<string, number>()
  if (account?.industry_vertical === 'hotel') {
    const ids = typed.map((p) => p.id)
    const [{ data: rates }, { data: caps, error: capsError }] = await Promise.all([
      db
        .from('product_rates')
        .select('product_id, day_of_week, occupancy, price, date_from, date_to')
        .eq('account_id', accountId)
        .in('product_id', ids),
      // Separate read: a missing column (code ahead of migration 160) only
      // drops the capacity note, never the catalog.
      db.from('products').select('id, max_guests').eq('account_id', accountId).in('id', ids),
    ])
    ratesByProduct = groupBy((rates as RateRow[] | null) ?? [], (r) => r.product_id)
    if (!capsError) {
      for (const c of (caps ?? []) as { id: string; max_guests: number | null }[]) {
        if (c.max_guests && c.max_guests > 0) maxGuestsByProduct.set(c.id, c.max_guests)
      }
    }
  }

  return typed.map((p) => {
    const desc = p.description ? ` — ${truncate(p.description, MAX_DESCRIPTION_CHARS)}` : ''
    const rates = ratesByProduct.get(p.id) ?? []
    if (rates.length > 0) {
      const cap = maxGuestsByProduct.get(p.id)
      const capNote = cap ? ` · capacidad máx. ${cap} personas (adultos + niños)` : ''
      return `- ${p.name}: ${formatRateSummary(rates, currency)}${capNote}${desc}`
    }
    return `- ${p.name} (${formatCurrency(p.price, currency)})${desc}`
  })
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = map.get(k) ?? []
    list.push(row)
    map.set(k, list)
  }
  return map
}

/** "Lun–Jue Q800 · Vie Q1000 · Sáb–Dom Q1200 · pareja Lun–Dom Q1400
 *  · temporada 24/12/2026–31/12/2026: Lun–Dom Q1500". Compact enough for
 *  the prompt. */
function formatRateSummary(rates: RateRow[], currency: string): string {
  const fmt = (n: number) => formatCurrency(n, currency)
  const parts: string[] = []
  const always = summarizeRates(rates, fmt)
  if (always) parts.push(always)

  // One clause per season, broken down by day and guest tier exactly like
  // the always-on rates. Before, every season collapsed into a single
  // unlabeled price list under the FIRST season's dates — two seasons
  // (fin de año + Semana Santa) read as one, with no hint which price
  // was for how many guests.
  const bySeason = new Map<string, RateRow[]>()
  for (const r of rates) {
    if (!r.date_from || !r.date_to) continue
    const key = `${r.date_from}|${r.date_to}`
    bySeason.set(key, [...(bySeason.get(key) ?? []), r])
  }
  for (const [key, rows] of [...bySeason].sort(([a], [b]) => a.localeCompare(b))) {
    const [from, to] = key.split('|')
    const body = summarizeRates(rows.map((r) => ({ ...r, date_from: null, date_to: null })), fmt)
    if (body) parts.push(`temporada ${formatDateEs(from)}–${formatDateEs(to)}: ${body}`)
  }
  return parts.join(' · ')
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}
