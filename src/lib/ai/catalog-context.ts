import { hasPendingSeasonRates } from '@/lib/products/rate-approval'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/currency'
import { formatDateEs, summarizeRates, type DayOfWeek } from '@/lib/products/rates'

// Bounds how much of the catalog reaches the prompt — plenty for a
// small/medium product list, keeps token spend predictable for
// accounts with a large one.
const MAX_PRODUCTS_IN_PROMPT = 50
const MAX_DESCRIPTION_CHARS = 80
const MAX_COMMERCE_DESCRIPTION_CHARS = 300
const MAX_QUERY_TOKENS = 8
const MAX_CATALOG_QUERY_CHARS = 2000
const CATALOG_QUERY_STOP_WORDS = new Set([
  'al', 'algo', 'como', 'con', 'cual', 'cuando', 'cuanto', 'cuesta', 'cuestan', 'de', 'del', 'el', 'en', 'es', 'esa', 'ese', 'esta', 'este',
  'foto', 'fotos', 'gracias', 'hola', 'la', 'las', 'lo', 'los', 'me', 'mi', 'necesito', 'para', 'por', 'precio', 'precios', 'puede', 'que',
  'quiero', 'saber', 'se', 'si', 'sobre', 'su', 'tienen', 'tiene', 'un', 'una', 'unos', 'unas', 'ver', 'y',
  'asi', 'bien', 'confirmo', 'confirmar', 'confirma', 'confirmado', 'correcto', 'dejo', 'direccion', 'entrega', 'le', 'nombre', 'pago',
  'pedido', 'producto', 'productos', 'resumen', 'tarjeta', 'telefono', 'total', 'unidad', 'unidades',
])

/** Recent customer intent plus the summary they may be confirming. Limit
 * each turn so a long message cannot crowd all previous product names out. */
export function catalogQueryFromMessages(messages: readonly { role: string; content: string }[]): string {
  return messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-4).reverse()
    .map((m) => m.content.slice(0, 500)).join('\n').slice(0, MAX_CATALOG_QUERY_CHARS)
}

function normalizeProductSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function catalogQueryTokens(query: string): string[] {
  const groups = query.slice(0, MAX_CATALOG_QUERY_CHARS).split('\n').map((turn) => normalizeProductSearch(turn).split(' ')
    .filter((token) => token.length >= 2 && token.length <= 40 && !/^\d{5,}$/.test(token) && !CATALOG_QUERY_STOP_WORDS.has(token)))
  const selected = new Set<string>()
  // Give the current turn first priority while retaining room for the
  // preceding product summary after replies such as "sí" or "lo quiero".
  for (const token of groups[0]?.slice(0, 4) ?? []) selected.add(token)
  const longest = Math.max(0, ...groups.map((g) => g.length))
  for (let i = 0; i < longest && selected.size < MAX_QUERY_TOKENS; i++) {
    for (const group of groups) {
      if (group[i]) selected.add(group[i])
      if (selected.size === MAX_QUERY_TOKENS) break
    }
  }
  return [...selected]
}

function productRelevance(product: CatalogProductRow, query: string, tokens: string[]): number {
  const name = normalizeProductSearch(product.name)
  const matched = tokens.filter((token) => name.includes(token)).length
  if (!matched) return 0
  // The complete named item beats another product that merely shares a word.
  const nameAt = query.indexOf(name)
  return (nameAt >= 0 ? 100_000 + (query.length - nameAt) * 100 : 0) + matched * 10
}

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
  occupancy: 'standard' | 'couple' | 'group' | 'quad' | 'quint' | 'child'
  price: number
  date_from: string | null
  date_to: string | null
}

export async function loadCatalogContext(
  db: SupabaseClient,
  accountId: string,
  query = '',
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
  let typed = products as CatalogProductRow[]
  const normalizedQuery = normalizeProductSearch(query.slice(0, MAX_CATALOG_QUERY_CHARS))
  const tokens = catalogQueryTokens(query)
  if (tokens.length) {
    let relevant: CatalogProductRow[] = []
    // Small catalogs are already complete. On larger ones, find matching
    // active names in the database without loading the rest of the catalog.
    if (typed.length === MAX_PRODUCTS_IN_PROMPT) {
      // User punctuation and wildcards never reach PostgREST syntax. The
      // generated single-character vowel wildcards also match accented names;
      // false positives are removed below by accent-insensitive relevance.
      const filters = tokens.map((token) => `name.ilike.%${token.replace(/[aeiou]/g, '_')}%`)
      const search = async (filter: string): Promise<CatalogProductRow[]> => {
        try {
          const { data, error } = await db.from('products').select('id, name, price, description')
            .eq('account_id', accountId).eq('is_active', true).or(filter).order('name').limit(MAX_PRODUCTS_IN_PROMPT)
          return error ? [] : ((data ?? []) as CatalogProductRow[]).filter((p) => productRelevance(p, normalizedQuery, tokens) > 0)
        } catch {
          // An unavailable search must not discard the already-loaded catalog.
          return []
        }
      }
      // Prefer names containing every search term before the broad fallback,
      // so a common word cannot crowd the named product out of the first 50.
      relevant = await search(filters.length > 1 ? `and(${filters.join(',')})` : filters[0])
      if (!relevant.length && filters.length > 1) relevant = await search(filters.join(','))
    }
    const unique = new Map<string, CatalogProductRow>()
    for (const product of [...typed, ...relevant]) unique.set(product.id || product.name, product)
    typed = [...unique.values()].sort((a, b) => productRelevance(b, normalizedQuery, tokens) - productRelevance(a, normalizedQuery, tokens)
      || a.name.localeCompare(b.name)).slice(0, MAX_PRODUCTS_IN_PROMPT)
  }

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
    const descriptionLimit = account?.industry_vertical === 'hotel' ? 1200
      : account?.industry_vertical === 'dropshipping' ? MAX_COMMERCE_DESCRIPTION_CHARS : MAX_DESCRIPTION_CHARS
    const desc = p.description ? ` — ${truncate(p.description, descriptionLimit)}` : ''
    const rates = ratesByProduct.get(p.id) ?? []
    if (rates.length > 0) {
      const cap = maxGuestsByProduct.get(p.id)
      const capNote = cap ? ` · capacidad máx. ${cap} personas (adultos + niños)` : ''
      const pending = hasPendingSeasonRates(p.description)
      const visibleRates = pending ? rates.filter(r => !r.date_from && !r.date_to) : rates
      const approvalNote = pending ? ' TEMPORADA ALTA: precio pendiente de confirmaci\u00f3n del hotel; no cotizar las tarifas de adulto de esas temporadas.' : ''
      return `- ${p.name}: ${formatRateSummary(visibleRates, currency)}${capNote}${desc}${approvalNote}`
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
