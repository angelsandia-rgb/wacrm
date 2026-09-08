import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/currency'
import {
  quoteStay,
  occupancyForGuests,
  DAY_LABEL_ES,
  OCCUPANCY_LABEL_ES,
  type ProductRate,
} from '@/lib/products/rates'

// ============================================================
// Pre-computed stay total for the auto-reply hotel bot.
//
// The bot only ever received the RATE SUMMARY string ("pareja Lun–Jue
// Q500 · Vie–Dom Q700"), so answering "¿cuánto sería?" meant it had to
// work out the weekday of each night, pick the right tariff and add
// them up itself — which a small model gets wrong or, more often,
// dodges ("un compañero te confirma el total"). This runs the same
// `quoteStay()` the public catalog + quote builder use and hands the
// finished figure to the prompt.
//
// Only fires when there's a pending `reservation_requests` row for the
// conversation (habitaciones / paquetes) with both dates set and the
// product's per-night rates resolve.
// ============================================================

interface ReservationRow {
  id: string
  category: string
  service_name: string | null
  product_id: string | null
  guests: number | null
  check_in: string | null
  check_out: string | null
  estimated_price: number | null
}

/**
 * A ready-to-share stay estimate (Spanish, with the numbers), or null.
 * Also back-fills `reservation_requests.estimated_price` when it's still
 * null and every night priced cleanly — so the Google Sheet row and the
 * hotel Panel pick up the same figure.
 */
export async function loadHotelStayEstimate(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  currency: string,
): Promise<string | null> {
  const { data: rr } = await db
    .from('reservation_requests')
    .select('id, category, service_name, product_id, guests, check_in, check_out, estimated_price')
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .in('category', ['habitaciones', 'paquetes'])
    .not('check_in', 'is', null)
    .not('check_out', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle<ReservationRow>()
  if (!rr || !rr.check_in || !rr.check_out) return null

  const productId = await resolveProductId(db, accountId, rr)
  if (!productId) return null

  const { data: rateRows } = await db
    .from('product_rates')
    .select('day_of_week, occupancy, price, date_from, date_to')
    .eq('account_id', accountId)
    .eq('product_id', productId)
  const rates = (rateRows ?? []) as ProductRate[]
  if (rates.length === 0) return null

  // Never invent an occupancy: it determines the tariff.
  if (!rr.guests || !Number.isInteger(rr.guests) || rr.guests < 1) return null
  const guests = rr.guests
  const occupancy = occupancyForGuests(guests)
  const quote = quoteStay(rates, rr.check_in, rr.check_out, occupancy)
  if (quote.nights.length === 0) return null

  const label = (rr.service_name ?? 'la habitación').trim() || 'la habitación'
  const occLabel = OCCUPANCY_LABEL_ES[occupancy].trim() || 'individual'
  const nightsWord = quote.nights.length === 1 ? 'noche' : 'noches'
  const breakdown = quote.nights
    .map((n) => `${n.date} ${DAY_LABEL_ES[n.day_of_week].toLowerCase()} ${n.price == null ? '(sin tarifa)' : formatCurrency(n.price, currency)}`)
    .join(' · ')

  let text =
    `${label} · ${guests} personas (${occLabel}) · ${quote.nights.length} ${nightsWord} ` +
    `(${rr.check_in} al ${rr.check_out}): ${breakdown}. ` +
    `${quote.missing.length ? 'Subtotal de noches con tarifa' : 'Total estimado'}: ${formatCurrency(quote.total, currency)}.`
  if (quote.missing.length > 0) {
    text += ` (${quote.missing.join(', ')} sin tarifa publicada — esas noches las cotiza una persona.)`
  }
  text +=
    ' Este total sale de las tarifas publicadas del hotel; es un estimado — la disponibilidad y el precio final los confirma una persona.'

  // Best-effort: seed the reservation's price so the Sheet + Panel agree.
  if (rr.estimated_price == null && quote.missing.length === 0 && quote.total > 0) {
    await db
      .from('reservation_requests')
      .update({ estimated_price: quote.total })
      .eq('id', rr.id)
      .is('estimated_price', null)
  }

  return text
}

/** The AI's `record_reservation` marker rarely carries a product_id, so
 *  fall back to matching the captured `service_name` against an active
 *  product (exact, then contains either way). */
async function resolveProductId(
  db: SupabaseClient,
  accountId: string,
  rr: ReservationRow,
): Promise<string | null> {
  const name = rr.service_name?.trim().toLowerCase()
  if (!rr.product_id && !name) return null

  let query = db
    .from('products')
    .select('id, name')
    .eq('account_id', accountId)
    .eq('is_active', true)
  if (rr.product_id) query = query.eq('id', rr.product_id)
  const { data: products, error } = await query
  if (error) return null
  const list = (products ?? []) as { id: string; name: string }[]
  if (rr.product_id) return list.find((p) => p.id === rr.product_id)?.id ?? null
  if (!name || list.length >= 1000) return null // cannot establish uniqueness on a capped result

  const exact = list.filter((p) => p.name.trim().toLowerCase() === name)
  if (exact.length) return exact.length === 1 ? exact[0].id : null
  const contains = list.filter((p) => {
    const pn = p.name.trim().toLowerCase()
    return pn.includes(name) || name.includes(pn)
  })
  return contains.length === 1 ? contains[0].id : null
}
