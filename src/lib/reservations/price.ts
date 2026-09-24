import type { SupabaseClient } from '@supabase/supabase-js'
import { quoteStay, occupancyForGuests, type ProductRate } from '@/lib/products/rates'

// ============================================================
// Best-effort per-night total for a room / package stay, from the
// product's published `product_rates`. One source of truth shared by:
//   - src/lib/ai/hotel-stay-estimate.ts  (builds the "¿cuánto sería?" text)
//   - src/lib/reservations/upsert.ts     (persists the figure so the
//     Google Sheet row + hotel Panel agree, and keeps it in step when
//     the guest moves their dates)
// ============================================================

export interface StayForPricing {
  product_id?: string | null
  service_name?: string | null
  guests?: number | null
  /** Identical rooms (migration 159). null/1 = one room. */
  rooms?: number | null
  check_in?: string | null
  check_out?: string | null
}

/** How many rooms a request covers — null/0/garbage count as one. */
export function roomCount(rooms: number | null | undefined): number {
  return rooms && Number.isInteger(rooms) && rooms > 1 ? rooms : 1
}

/**
 * Guests per room when `guests` (the TOTAL) splits evenly across the
 * rooms — "2 Premium para 4 personas" → 2 each. `null` when it doesn't
 * (5 people in 2 rooms): how they split is the guest's call, so a person
 * prices it instead of us guessing.
 */
export function guestsPerRoom(guests: number | null | undefined, rooms: number | null | undefined): number | null {
  if (!guests || !Number.isInteger(guests) || guests < 1) return null
  const n = roomCount(rooms)
  if (guests < n || guests % n !== 0) return null
  return guests / n
}

/**
 * The stay total (all rooms), or `null` — meaning "a human prices this"
 * — when the product can't be resolved, the guest count is unusable or
 * doesn't split evenly across the rooms, there are no rates, or any
 * night lacks a published rate.
 */
export async function estimateStayPrice(
  db: SupabaseClient,
  accountId: string,
  stay: StayForPricing,
): Promise<number | null> {
  if (!stay.check_in || !stay.check_out) return null
  const perRoom = guestsPerRoom(stay.guests, stay.rooms)
  if (perRoom === null) return null

  const productId = await resolveStayProductId(db, accountId, stay)
  if (!productId) return null

  const { data: rateRows } = await db
    .from('product_rates')
    .select('day_of_week, occupancy, price, date_from, date_to')
    .eq('account_id', accountId)
    .eq('product_id', productId)
  const rates = (rateRows ?? []) as ProductRate[]
  if (rates.length === 0) return null

  const quote = quoteStay(rates, stay.check_in, stay.check_out, occupancyForGuests(perRoom))
  if (quote.nights.length === 0 || quote.missing.length > 0 || quote.total <= 0) return null
  return quote.total * roomCount(stay.rooms)
}

/** The deposit ("anticipo") owed on a fully-priced stay total, rounded to
 *  the nearest whole unit — same source of truth as the total itself, so
 *  the AI never has to compute a percentage on its own. */
export function estimateDeposit(total: number, depositPercent: number): number {
  return Math.round((total * depositPercent) / 100)
}

/**
 * The AI's `record_reservation` marker rarely carries a `product_id`, so
 * fall back to matching the captured `service_name` against an active
 * product (exact, then a unique substring match either way). `null` when
 * it can't be pinned to exactly one product.
 */
export async function resolveStayProductId(
  db: SupabaseClient,
  accountId: string,
  stay: Pick<StayForPricing, 'product_id' | 'service_name'>,
): Promise<string | null> {
  const name = stay.service_name?.trim().toLowerCase()
  if (!stay.product_id && !name) return null

  let query = db
    .from('products')
    .select('id, name')
    .eq('account_id', accountId)
    .eq('is_active', true)
  if (stay.product_id) query = query.eq('id', stay.product_id)
  const { data: products, error } = await query
  if (error) return null
  const list = (products ?? []) as { id: string; name: string }[]
  if (stay.product_id) return list.find((p) => p.id === stay.product_id)?.id ?? null
  if (!name || list.length >= 1000) return null // cannot establish uniqueness on a capped result

  const exact = list.filter((p) => p.name.trim().toLowerCase() === name)
  if (exact.length) return exact.length === 1 ? exact[0].id : null
  const contains = list.filter((p) => {
    const pn = p.name.trim().toLowerCase()
    return pn.includes(name) || name.includes(pn)
  })
  return contains.length === 1 ? contains[0].id : null
}
