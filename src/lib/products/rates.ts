// ============================================================
// Per-day room rates for the `hotel` industry vertical (migrations 106
// + 108 + 111). Pure — no I/O, fully unit-tested. Shared by:
//   - POST/PATCH /api/products        (validation: parseRates)
//   - the quote builder               (quoteStay)
//   - the public catalog stay quote   (quoteStay)
//   - src/lib/ai/catalog-context.ts   (rate structure shown to the AI)
//
// A room's nightly price is a distinct number for every day of the
// week (Mon…Sun), crossed with a guest tier — standard (1 guest),
// couple (2), group (3+) — where couple/group are optional and fall
// back to standard. An optional date range gives a seasonal override
// that wins for the nights inside it.
// ============================================================

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

/** Mon→Sun display / iteration order. */
export const DAY_ORDER: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

const DAY_CODES = new Set<string>(DAY_ORDER)

export const DAY_LABEL_ES: Record<DayOfWeek, string> = {
  mon: 'Lun',
  tue: 'Mar',
  wed: 'Mié',
  thu: 'Jue',
  fri: 'Vie',
  sat: 'Sáb',
  sun: 'Dom',
}

/** standard = 1 guest · couple = 2 guests · group = 3 guests · quad = 4
 *  guests. `couple`, `group` and `quad` are optional tiers — a missing
 *  one falls back to the standard rate. 5+ guests has no tier at all
 *  (Angel, 2026-09-18: never estimate for a group that large — always
 *  forward the request to a person instead); see `occupancyForGuests`. */
export type Occupancy = 'standard' | 'couple' | 'group' | 'quad'

/** Display order for the occupancy tiers (used by every rate summary). */
export const OCCUPANCY_ORDER: Occupancy[] = ['standard', 'couple', 'group', 'quad']

/** A row of `product_rates`, request-body or DB shape (only the fields
 *  the resolver needs). */
export interface ProductRate {
  day_of_week: DayOfWeek
  occupancy: Occupancy
  price: number
  /** ISO `YYYY-MM-DD`. Both null = the always-on rate; both set = a
   *  seasonal override for `[date_from, date_to]` inclusive. */
  date_from: string | null
  date_to: string | null
}

export const MAX_PRODUCT_RATES = 84 // 7 days × 4 occupancies × up to 3 seasons

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isValidHotelDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** ISO `YYYY-MM-DD` → `DD/MM/AAAA`, the format guests in Guatemala
 *  expect in a WhatsApp reply. Every customer-facing (and staff-facing
 *  handoff/internal-note) date in the hotel vertical goes through this
 *  — the model's own `record_reservation` marker keeps YYYY-MM-DD
 *  internally (needed for day-of-week/rate lookups) and is never shown
 *  to a guest as-is. Returns the input unchanged when it isn't a valid
 *  ISO date, so a bad value degrades gracefully instead of throwing. */
export function formatDateEs(iso: string): string {
  if (!isValidHotelDate(iso)) return iso
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export const MAX_STAY_NIGHTS = 366

const JS_DAY_TO_CODE: DayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** The day-of-week code for an ISO date. */
export function dayOfWeekOf(dateISO: string): DayOfWeek {
  const day = new Date(`${dateISO}T12:00:00Z`).getUTCDay() // 0 = Sun … 6 = Sat
  return JS_DAY_TO_CODE[day]
}

/**
 * The nights of a stay as ISO dates — check-in inclusive, check-out
 * exclusive (you don't pay for the night you leave). Returns `[]` for a
 * malformed or non-positive range.
 */
export function nightsBetween(checkInISO: string, checkOutISO: string): string[] {
  if (!isValidHotelDate(checkInISO) || !isValidHotelDate(checkOutISO)) return []
  const start = new Date(`${checkInISO}T12:00:00Z`)
  const end = new Date(`${checkOutISO}T12:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return []
  if (end.getTime() <= start.getTime()) return []
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_STAY_NIGHTS) return []

  const out: string[] = []
  const cursor = new Date(start)
  // Cap to a sane stay length so a bad input can't spin.
  for (let i = 0; i < 366 && cursor.getTime() < end.getTime(); i += 1) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

function seasonContains(rate: ProductRate, nightISO: string): boolean {
  if (!rate.date_from || !rate.date_to) return false
  return nightISO >= rate.date_from && nightISO <= rate.date_to
}

/**
 * The highest occupancy tier a product has EVER been priced for, on any
 * day or season — lets `resolveNightlyRate` tell "this room just doesn't
 * have a rate for this ONE day at a tier it does use elsewhere" (safe to
 * fall back to `standard`, as before) apart from "this room was never
 * configured for this many guests at all" (must NOT fall back — see
 * below). Ignores non-positive/invalid prices, same as `resolveNightlyRate`.
 */
function maxDefinedOccupancy(rates: ProductRate[]): Occupancy {
  let max: Occupancy = 'standard'
  for (const r of rates) {
    if (!Number.isFinite(r.price) || r.price <= 0) continue
    if (OCCUPANCY_ORDER.indexOf(r.occupancy) > OCCUPANCY_ORDER.indexOf(max)) max = r.occupancy
  }
  return max
}

/**
 * The price for one night, given all of a product's rates.
 *
 * Resolution order:
 *   1. exact occupancy + day of week, seasonal row covering the night
 *   2. exact occupancy + day of week, always-on row
 *   3. (occupancy 'couple' / 'group' / 'quad' only, AND only when this
 *      product has a rate for that tier on at least one OTHER day — see
 *      `maxDefinedOccupancy`) fall back to the 'standard' rate for the
 *      same day
 *
 * `occupancy: null` (5+ guests — see `occupancyForGuests`) always
 * returns `null`: there is no tier to resolve or fall back to, by
 * design — a group that large is never priced automatically.
 *
 * Real incident, 2026-09-20: a 3-guest request for a couple-only room
 * (max tier ever configured: 'couple') fell back to the 'standard'
 * (1-guest) rate and silently under-priced the stay by half — the room
 * was never priced for 'group' at all, on any day, so there was no
 * missing DAY to patch over, just a headcount the room doesn't offer.
 * Falling back only when the tier is used elsewhere keeps the original
 * "missing this one day" leniency while refusing to guess for a
 * capacity that was never configured, on any day.
 *
 * Returns `null` when nothing matches (the caller surfaces it as a gap).
 */
export function resolveNightlyRate(
  rates: ProductRate[],
  nightISO: string,
  occupancy: Occupancy | null,
): number | null {
  if (occupancy === null) return null
  const day = dayOfWeekOf(nightISO)
  const valid = (r: ProductRate) => r.day_of_week === day && Number.isFinite(r.price) && r.price > 0
  // A season that prices THIS night (any tier) owns it entirely: a tier
  // it leaves out must never borrow the cheaper always-on rate. Real
  // case, Villa San Ricardo high season (2026-09-24): the season lists
  // 2–3 guests for the Junior Suite but not 4 — a 4-guest Semana Santa
  // stay would otherwise have been quoted at the normal weekend rate.
  const seasonalForDay = rates.filter((r) => valid(r) && seasonContains(r, nightISO))
  const pool = seasonalForDay.length
    ? seasonalForDay
    : rates.filter((r) => valid(r) && !r.date_from && !r.date_to)
  const tryOccupancy = (occ: Occupancy): number | null | 'ambiguous' => {
    const candidates = pool.filter((r) => r.occupancy === occ)
    const prices = new Set(candidates.map((r) => r.price))
    if (prices.size > 1) return 'ambiguous'
    return prices.size === 1 ? candidates[0].price : null
  }

  const exact = tryOccupancy(occupancy)
  if (exact === 'ambiguous') return null
  if (exact !== null) return exact
  if (occupancy === 'couple' || occupancy === 'group' || occupancy === 'quad') {
    const reference = seasonalForDay.length ? seasonalForDay : rates
    if (OCCUPANCY_ORDER.indexOf(occupancy) > OCCUPANCY_ORDER.indexOf(maxDefinedOccupancy(reference))) {
      return null
    }
    const fallback = tryOccupancy('standard')
    return fallback === 'ambiguous' ? null : fallback
  }
  return null
}

/** Map a guest count to an occupancy tier: 1 → standard, 2 → couple,
 *  3 → group, 4 → quad. `null` for 5+ — deliberately no tier at all,
 *  so a stay for that many guests is never auto-priced; the caller
 *  must forward the request to a person instead (Angel, 2026-09-18). */
export function occupancyForGuests(guests: number): Occupancy | null {
  if (guests >= 5) return null
  if (guests === 4) return 'quad'
  if (guests === 3) return 'group'
  if (guests === 2) return 'couple'
  return 'standard'
}

export interface StayNight {
  date: string
  day_of_week: DayOfWeek
  price: number | null
}

export interface StayQuote {
  nights: StayNight[]
  /** Sum of the priced nights only. */
  total: number
  /** ISO dates with no resolvable rate — a human must price these. */
  missing: string[]
}

/** Price a whole stay night-by-night. `occupancy: null` (5+ guests)
 *  prices nothing — every night comes back in `missing`. */
export function quoteStay(
  rates: ProductRate[],
  checkInISO: string,
  checkOutISO: string,
  occupancy: Occupancy | null = 'standard',
): StayQuote {
  const nights = nightsBetween(checkInISO, checkOutISO).map((date): StayNight => {
    const price = resolveNightlyRate(rates, date, occupancy)
    return { date, day_of_week: dayOfWeekOf(date), price }
  })
  const total = nights.reduce((sum, n) => sum + (n.price ?? 0), 0)
  const missing = nights.filter((n) => n.price === null).map((n) => n.date)
  return { nights, total, missing }
}

// ------------------------------------------------------------
// One-line human summary of a product's always-on rates
// ------------------------------------------------------------

export const OCCUPANCY_LABEL_ES: Record<Occupancy, string> = {
  standard: '',
  couple: 'pareja ',
  group: 'grupo ',
  quad: '4 personas ',
}

/** Collapse a run of consecutive same-priced days into "Lun–Jue Q800",
 *  a single day into "Vie Q1000". `days` must be in Mon→Sun order.
 *
 *  A run touching Monday and a run ending on Sunday that share the same
 *  price are really ONE run that wraps past `DAY_ORDER`'s Mon-first
 *  array boundary — e.g. a hotel's "domingo a jueves" corporate rate,
 *  which is Sun+Mon–Thu, not Mon–Thu with Sunday floating off on its
 *  own after a pricier Fri–Sat. Left unmerged, that reads as "Lun–Jue
 *  Q300 · Vie–Sáb Q400 · Dom Q300" — Sunday's identical price looks
 *  like a separate, confusing data point instead of what it is (Angel,
 *  2026-09-18: "el precio para domingo... se puede integrar a los
 *  demás precios"). Merged, it reads "Dom–Jue Q300 · Vie–Sáb Q400". */
function collapseDayRuns(
  entries: { day: DayOfWeek; price: number }[],
  fmt: (n: number) => string,
): string {
  const byDay = new Map(entries.map((e) => [e.day, e.price]))
  const present = DAY_ORDER.filter((d) => byDay.has(d))
  if (present.length === 0) return ''

  type Run = { startIdx: number; endIdx: number; price: number }
  const runs: Run[] = []
  let i = 0
  while (i < present.length) {
    const price = byDay.get(present[i])!
    let j = i
    // Extend while the next present day is the immediate next weekday and
    // carries the same price.
    while (
      j + 1 < present.length &&
      DAY_ORDER.indexOf(present[j + 1]) === DAY_ORDER.indexOf(present[j]) + 1 &&
      byDay.get(present[j + 1]) === price
    ) {
      j += 1
    }
    runs.push({ startIdx: i, endIdx: j, price })
    i = j + 1
  }

  if (
    runs.length >= 2 &&
    DAY_ORDER.indexOf(present[runs[0].startIdx]) === 0 && // first run starts Monday
    DAY_ORDER.indexOf(present[runs[runs.length - 1].endIdx]) === 6 && // last run ends Sunday
    runs[0].price === runs[runs.length - 1].price
  ) {
    const first = runs.shift()!
    const last = runs.pop()!
    runs.unshift({ startIdx: last.startIdx, endIdx: first.endIdx, price: first.price })
  }

  return runs
    .map((r) => {
      const startDay = present[r.startIdx]
      const endDay = present[r.endIdx]
      const label =
        r.startIdx === r.endIdx ? DAY_LABEL_ES[startDay] : `${DAY_LABEL_ES[startDay]}–${DAY_LABEL_ES[endDay]}`
      return `${label} ${fmt(r.price)}`
    })
    .join(' · ')
}

/**
 * One-line human summary of a product's always-on rates (seasonal rows
 * are ignored — they add noise in a catalog listing). `fmt` formats a
 * money amount. Empty string when there are no always-on rates.
 *
 * e.g. "Lun–Jue Q800 · Vie Q1000 · Sáb–Dom Q1200 · pareja Lun–Dom Q1400"
 */
export function summarizeRates(
  rates: Pick<ProductRate, 'day_of_week' | 'occupancy' | 'price' | 'date_from' | 'date_to'>[],
  fmt: (amount: number) => string,
): string {
  // A 0 / negative price is "no rate for that day/tier", not a free night.
  const always = rates.filter((r) => !r.date_from && !r.date_to && r.price > 0)
  if (always.length === 0) return ''
  return OCCUPANCY_ORDER.flatMap((occ) => {
    const forOcc = always
      .filter((r) => r.occupancy === occ)
      .map((r) => ({ day: r.day_of_week, price: r.price }))
    if (forOcc.length === 0) return []
    const body = collapseDayRuns(forOcc, fmt)
    return body ? [`${OCCUPANCY_LABEL_ES[occ]}${body}`] : []
  }).join(' · ')
}

// ------------------------------------------------------------
// Compact single-cell encoding for the products Excel export/import.
// One `room_rates` column instead of 28 rate_* columns. Always-on
// rates only — seasonal overrides are not round-tripped via Excel.
//
//   "mon=800/950/1600;fri=1200;sat=1400//1700"
//
// entry = `<day>=<standard>[/<couple>[/<group>[/<quad>]]]`, following
// OCCUPANCY_ORDER; a skipped middle tier is an empty slot ("1400//1700"
// = standard 1400, no couple, group 1700, no quad).
// ------------------------------------------------------------

type RoomRateLite = Pick<ProductRate, 'day_of_week' | 'occupancy' | 'price' | 'date_from' | 'date_to'>

export function formatRoomRatesCell(rates: RoomRateLite[]): string {
  const always = rates.filter((r) => !r.date_from && !r.date_to && r.price > 0)
  if (always.length === 0) return ''
  const parts: string[] = []
  for (const day of DAY_ORDER) {
    const slots = OCCUPANCY_ORDER.map((occ) => {
      const hit = always.find((r) => r.day_of_week === day && r.occupancy === occ)
      return hit ? String(hit.price) : ''
    })
    // Drop trailing empties.
    while (slots.length > 0 && slots[slots.length - 1] === '') slots.pop()
    if (slots.length === 0) continue
    parts.push(`${day}=${slots.join('/')}`)
  }
  return parts.join(';')
}

/** Parse a `room_rates` cell into rate rows (always-on). Returns `null`
 *  when the cell can't be read as the format (so the caller can flag the
 *  Excel row); an empty/blank cell yields `[]`. */
export function parseRoomRatesCell(
  raw: string,
): { day_of_week: DayOfWeek; occupancy: Occupancy; price: number }[] | null {
  const text = raw.trim()
  if (text === '') return []
  const out: { day_of_week: DayOfWeek; occupancy: Occupancy; price: number }[] = []
  for (const entry of text.split(';')) {
    const chunk = entry.trim()
    if (chunk === '') continue
    const eq = chunk.indexOf('=')
    if (eq < 1) return null
    const day = chunk.slice(0, eq).trim().toLowerCase()
    if (!DAY_CODES.has(day)) return null
    const slots = chunk.slice(eq + 1).split('/')
    if (slots.length > OCCUPANCY_ORDER.length) return null
    for (let i = 0; i < slots.length; i += 1) {
      const v = slots[i].trim()
      if (v === '') continue
      const price = Number(v)
      if (!Number.isFinite(price) || price < 0) return null
      out.push({ day_of_week: day as DayOfWeek, occupancy: OCCUPANCY_ORDER[i], price })
    }
  }
  return out
}

// ------------------------------------------------------------
// Request-body validation — sibling of parsePriceOptions in
// price-options.ts. Used by POST /api/products and PATCH /api/products/[id].
// ------------------------------------------------------------

export interface ParsedRate {
  day_of_week: DayOfWeek
  occupancy: Occupancy
  price: number
  date_from: string | null
  date_to: string | null
  position: number
}

export type ParseRatesResult =
  | { ok: true; rates: ParsedRate[] }
  | { ok: false; error: string }

export function parseRates(raw: unknown): ParseRatesResult {
  if (raw === undefined || raw === null) return { ok: true, rates: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'rates must be an array' }
  if (raw.length > MAX_PRODUCT_RATES) {
    return { ok: false, error: `A product may have at most ${MAX_PRODUCT_RATES} rates` }
  }

  const rates: ParsedRate[] = []
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `rates[${i}] must be an object` }
    }
    const row = entry as Record<string, unknown>

    const day = row.day_of_week
    if (typeof day !== 'string' || !DAY_CODES.has(day)) {
      return {
        ok: false,
        error: `rates[${i}].day_of_week must be one of mon,tue,wed,thu,fri,sat,sun`,
      }
    }
    const occupancy = row.occupancy ?? 'standard'
    if (
      occupancy !== 'standard' &&
      occupancy !== 'couple' &&
      occupancy !== 'group' &&
      occupancy !== 'quad'
    ) {
      return { ok: false, error: `rates[${i}].occupancy must be 'standard', 'couple', 'group' or 'quad'` }
    }
    const price = Number(row.price)
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: `rates[${i}].price must be a non-negative number` }
    }

    const from = row.date_from
    const to = row.date_to
    const fromSet = typeof from === 'string' && from.trim() !== ''
    const toSet = typeof to === 'string' && to.trim() !== ''
    if (fromSet !== toSet) {
      return { ok: false, error: `rates[${i}] must set both date_from and date_to, or neither` }
    }
    let dateFrom: string | null = null
    let dateTo: string | null = null
    if (fromSet && toSet) {
      if (!isValidHotelDate(from) || !isValidHotelDate(to)) {
        return { ok: false, error: `rates[${i}] dates must be YYYY-MM-DD` }
      }
      if ((to as string) < (from as string)) {
        return { ok: false, error: `rates[${i}].date_to must not be before date_from` }
      }
      dateFrom = from as string
      dateTo = to as string
    }

    rates.push({
      day_of_week: day as DayOfWeek,
      occupancy,
      price,
      date_from: dateFrom,
      date_to: dateTo,
      position: rates.length,
    })
  }

  for (let i = 0; i < rates.length; i += 1) {
    for (let j = i + 1; j < rates.length; j += 1) {
      const a = rates[i]
      const b = rates[j]
      if (a.day_of_week !== b.day_of_week || a.occupancy !== b.occupancy) continue
      const bothAlways = !a.date_from && !b.date_from
      const seasonsOverlap = Boolean(
        a.date_from && a.date_to && b.date_from && b.date_to &&
        a.date_from <= b.date_to && b.date_from <= a.date_to,
      )
      if (bothAlways || seasonsOverlap) {
        return { ok: false, error: `rates[${i}] and rates[${j}] overlap` }
      }
    }
  }

  return { ok: true, rates }
}
