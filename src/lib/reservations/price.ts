import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hasChildRates,
  occupancyForGuests,
  quoteStay,
  quoteStayWithChildren,
  splitChildAges,
  type ChildAgeSplit,
  type DayOfWeek,
  type Occupancy,
  type ProductRate,
} from '@/lib/products/rates'

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
  /** Adults in the request (migration 160); `guests` stays the total. */
  adults?: number | null
  /** Each child's age in years (migration 160). */
  children_ages?: number[] | null
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

/** The headcount a request covers: `guests` when set, else adults +
 *  children when only the split was captured. `null` when neither is
 *  usable. */
export function totalGuests(stay: Pick<StayForPricing, 'guests' | 'adults' | 'children_ages'>): number | null {
  if (stay.guests && Number.isInteger(stay.guests) && stay.guests >= 1) return stay.guests
  if (stay.adults && Number.isInteger(stay.adults) && stay.adults >= 1) {
    return stay.adults + (stay.children_ages?.length ?? 0)
  }
  return null
}

export interface PricedNight {
  date: string
  day_of_week: DayOfWeek
  price: number | null
}

/** Why a stay isn't auto-priced — or its quote. Pure; see `priceStay`. */
export type StayPricing =
  /** Dates or headcount missing, or a room that prices children still
   *  lacks the adults/children split — keep collecting. */
  | { kind: 'incomplete' }
  /** Several rooms whose headcount doesn't split evenly. */
  | { kind: 'uneven_rooms' }
  /** More people than the room takes (its `max_guests`, or 4 adults). */
  | { kind: 'too_large_group' }
  /** A shape the calculator doesn't price — a person does. */
  | { kind: 'needs_person'; reason: 'rooms_with_children' }
  | {
      kind: 'quoted'
      nights: PricedNight[]
      /** Per room. */
      total: number
      missing: string[]
      rooms: number
      guests: number
      perRoom: number
      /** Adult tier used (per room). */
      occupancy: Occupancy
      /** Present when the room prices children separately. */
      children: (ChildAgeSplit & { adults: number }) | null
      /** Why this is only an estimate the team must validate (empty = a
       *  normal quote). Owner, 2026-09-26: never refuse for headcount —
       *  quote what the published rates cover and say the team validates
       *  availability and the final price. */
      partial: PartialReason[]
    }

export type PartialReason =
  /** More adults than the highest tier (4): priced at the 4-person rate. */
  | 'adults_over_tier'
  /** More people than the room's capacity (a baby under 6 takes a place). */
  | 'over_capacity'
  /** A 13+ "child" — priced as an adult; the hotel confirms the rate. */
  | 'older_child'
  /** Fewer adults than the room's smallest adult tier (the Junior Suite
   *  has no 1-person rate): priced at that smallest tier. */
  | 'below_min_tier'

const TIER_GUESTS: Record<Occupancy, number> = { standard: 1, couple: 2, group: 3, quad: 4 }

/** The fewest adults the room has an always-on or seasonal rate for. */
function minPricedTierGuests(rates: ProductRate[]): number {
  let min = MAX_TIER_GUESTS
  for (const r of rates) {
    if (r.occupancy === 'child' || !(r.price > 0)) continue
    min = Math.min(min, TIER_GUESTS[r.occupancy])
  }
  return min
}

/** Highest adult tier the calculator prices. */
const MAX_TIER_GUESTS = 4

/**
 * How a stay prices against one product's rates. A room with `child`
 * rates needs the adults/children split (Angel, 2026-09-25: "cuántos
 * adultos y niños van") and prices adults by tier + each child 6–12 at
 * the night's child rate; every other room keeps pricing the whole
 * headcount by tier, as before.
 */
export function priceStay(rates: ProductRate[], stay: StayForPricing, maxGuests: number | null): StayPricing {
  if (!stay.check_in || !stay.check_out) return { kind: 'incomplete' }
  const guests = totalGuests(stay)
  if (guests === null) return { kind: 'incomplete' }
  const rooms = roomCount(stay.rooms)

  if (hasChildRates(rates)) {
    if (!stay.adults || !Number.isInteger(stay.adults) || stay.adults < 1) return { kind: 'incomplete' }
    const ages = stay.children_ages ?? []
    // "Somos 5: 2 adultos y 3 niños" with only two ages captured — keep
    // collecting instead of pricing a party that isn't fully known.
    if (stay.adults + ages.length !== guests) return { kind: 'incomplete' }
    if (rooms > 1 && ages.length > 0) return { kind: 'needs_person', reason: 'rooms_with_children' }
    if (rooms === 1) {
      // Never refuse for headcount (owner, 2026-09-26): price what the
      // published rates cover and flag it for the team instead.
      const split = splitChildAges(ages)
      const partial: PartialReason[] = []
      // A 13+ "child" is priced as an adult; the hotel confirms the rate.
      if (split.older > 0) partial.push('older_child')
      const pricedAdults = stay.adults + split.older
      if (pricedAdults > MAX_TIER_GUESTS) partial.push('adults_over_tier')
      if (guests > (maxGuests ?? MAX_TIER_GUESTS)) partial.push('over_capacity')
      const minTier = minPricedTierGuests(rates)
      if (pricedAdults < minTier) partial.push('below_min_tier')
      const tierGuests = Math.min(Math.max(pricedAdults, minTier), MAX_TIER_GUESTS)
      const occupancy = occupancyForGuests(tierGuests) ?? 'quad'
      const quote = quoteStayWithChildren(rates, stay.check_in, stay.check_out, tierGuests, split.charged)
      return {
        kind: 'quoted',
        nights: quote.nights,
        total: quote.total,
        missing: quote.missing,
        rooms,
        guests,
        perRoom: guests,
        occupancy,
        children: { ...split, adults: stay.adults },
        partial,
      }
    }
  }

  if (maxGuests && guests > maxGuests * rooms) return { kind: 'too_large_group' }

  const perRoom = guestsPerRoom(guests, stay.rooms)
  if (perRoom === null) return { kind: 'uneven_rooms' }
  const occupancy = occupancyForGuests(perRoom)
  if (occupancy === null) return { kind: 'too_large_group' }
  const quote = quoteStay(rates, stay.check_in, stay.check_out, occupancy)
  return {
    kind: 'quoted',
    nights: quote.nights,
    total: quote.total,
    missing: quote.missing,
    rooms,
    guests,
    perRoom,
    occupancy,
    children: null,
    partial: [],
  }
}

/** A product's rates and `max_guests` — the inputs `priceStay` needs.
 *  `max_guests` reads as null when the column isn't there yet (code
 *  deployed ahead of migration 160). */
export async function loadStayPricingInputs(
  db: SupabaseClient,
  accountId: string,
  productId: string,
): Promise<{ rates: ProductRate[]; maxGuests: number | null }> {
  const [{ data: rateRows }, { data: product, error: productErr }] = await Promise.all([
    db
      .from('product_rates')
      .select('day_of_week, occupancy, price, date_from, date_to')
      .eq('account_id', accountId)
      .eq('product_id', productId),
    db.from('products').select('max_guests').eq('account_id', accountId).eq('id', productId).maybeSingle(),
  ])
  const raw = productErr ? null : (product as { max_guests?: number | null } | null)?.max_guests
  return { rates: (rateRows ?? []) as ProductRate[], maxGuests: raw && raw > 0 ? raw : null }
}

/**
 * The stay total (all rooms), or `null` — meaning "a human prices this"
 * — when the product can't be resolved, the headcount is unusable or
 * doesn't split evenly across the rooms, there are no rates, or any
 * night lacks a published rate.
 */
export async function estimateStayPrice(
  db: SupabaseClient,
  accountId: string,
  stay: StayForPricing,
): Promise<number | null> {
  if (!stay.check_in || !stay.check_out || totalGuests(stay) === null) return null

  const productId = await resolveStayProductId(db, accountId, stay)
  if (!productId) return null

  const { rates, maxGuests } = await loadStayPricingInputs(db, accountId, productId)
  if (rates.length === 0) return null

  const pricing = priceStay(rates, stay, maxGuests)
  if (pricing.kind !== 'quoted') return null
  if (pricing.nights.length === 0 || pricing.missing.length > 0 || pricing.total <= 0) return null
  return pricing.total * pricing.rooms
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
