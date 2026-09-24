import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/currency'
import {
  quoteStay,
  occupancyForGuests,
  DAY_LABEL_ES,
  OCCUPANCY_LABEL_ES,
  formatDateEs,
  type ProductRate,
} from '@/lib/products/rates'
import { resolveStayProductId, estimateDeposit, guestsPerRoom, roomCount } from '@/lib/reservations/price'

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
  /** Identical rooms (migration 159). null = 1. `guests` is the total. */
  rooms: number | null
  check_in: string | null
  check_out: string | null
  estimated_price: number | null
}

/** "2 habitaciones × 2 personas" / "2 personas" — the headcount as the
 *  guest said it. */
function headcountEs(guests: number, rooms: number, perRoom: number): string {
  const people = (n: number) => `${n} ${n === 1 ? 'persona' : 'personas'}`
  return rooms > 1 ? `${rooms} habitaciones × ${people(perRoom)}` : people(guests)
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
  depositPercent = 50,
): Promise<string | null> {
  const { data: rr } = await db
    .from('reservation_requests')
    .select('id, category, service_name, product_id, guests, rooms, check_in, check_out, estimated_price')
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

  const productId = await resolveStayProductId(db, accountId, rr)
  if (!productId) return null

  const { data: rateRows } = await db
    .from('product_rates')
    .select('day_of_week, occupancy, price, date_from, date_to')
    .eq('account_id', accountId)
    .eq('product_id', productId)
  const rates = (rateRows ?? []) as ProductRate[]
  if (rates.length === 0) return null

  // Never invent an occupancy: it determines the tariff. Several rooms
  // price each at its per-room occupancy — only when the total splits
  // evenly (B43); otherwise a person prices it.
  if (!rr.guests || !Number.isInteger(rr.guests) || rr.guests < 1) return null
  const guests = rr.guests
  const rooms = roomCount(rr.rooms)
  const perRoom = guestsPerRoom(guests, rr.rooms)
  if (perRoom === null) return null
  const occupancy = occupancyForGuests(perRoom)
  // 5+ guests has no tier at all, by design (Angel, 2026-09-18): never
  // auto-estimate that large a group — the bot's existing "no estimate
  // calculated" fallback ("un compañero prepara la cotización") already
  // does exactly what's wanted here, so this is a plain bail-out rather
  // than building a text that would show a misleading Q0 subtotal.
  if (occupancy === null) return null
  const quote = quoteStay(rates, rr.check_in, rr.check_out, occupancy)
  if (quote.nights.length === 0) return null

  const label = (rr.service_name ?? 'la habitación').trim() || 'la habitación'
  const occLabel = OCCUPANCY_LABEL_ES[occupancy].trim() || 'individual'
  const nightsWord = quote.nights.length === 1 ? 'noche' : 'noches'
  const breakdown = quote.nights
    .map((n) => `${formatDateEs(n.date)} ${DAY_LABEL_ES[n.day_of_week].toLowerCase()} ${n.price == null ? '(sin tarifa)' : formatCurrency(n.price, currency)}`)
    .join(' · ')

  const total = quote.total * rooms
  let text =
    `${label} · ${headcountEs(guests, rooms, perRoom)} (${occLabel}) · ${quote.nights.length} ${nightsWord} ` +
    `(${formatDateEs(rr.check_in)} al ${formatDateEs(rr.check_out)}): ${breakdown}${rooms > 1 ? ' por habitación' : ''}. ` +
    `${quote.missing.length ? 'Subtotal de noches con tarifa' : 'Total estimado'}${rooms > 1 ? ` (${rooms} habitaciones)` : ''}: ${formatCurrency(total, currency)}.`
  if (quote.missing.length > 0) {
    text += ` (${quote.missing.join(', ')} sin tarifa publicada — esas noches las cotiza una persona.)`
  } else {
    // Deposit only makes sense once the total is real, not a partial
    // subtotal — matches "never fake a complete quote" (price.ts).
    const deposit = estimateDeposit(total, depositPercent)
    text += ` Para apartar se requiere un anticipo del ${depositPercent}%, equivalente a ${formatCurrency(deposit, currency)}.`
  }
  text +=
    ' Este total sale de las tarifas publicadas del hotel; es un estimado — la disponibilidad y el precio final los confirma una persona.'

  // Best-effort: seed the reservation's price so the Sheet + Panel agree.
  if (rr.estimated_price == null && quote.missing.length === 0 && total > 0) {
    await db
      .from('reservation_requests')
      .update({ estimated_price: total })
      .eq('id', rr.id)
      .is('estimated_price', null)
  }

  return text
}

// ============================================================
// Proactive stay-estimate follow-up (2026-09-20).
//
// Real incident: a guest asked for a Suite Clásica 2-night stay
// (Wed–Thu, both nights the CORPORATE rate). `resolveStayProductId`'s
// name match was ambiguous — "Suite Clásica" is a substring of BOTH
// "Suite Clásica (Individual o Pareja)" and "Suite Clásica Doble" — so
// it returned null, and `loadHotelStayEstimate` above returned null too.
// With no system-computed number to draw on, the model stated a price
// itself in its OWN reply (Q800, the single-night WEEKEND reference
// rate lifted from the business's tariff description) and put it in the
// `record_reservation` marker's `precio` field — which `autoRecordReservation`
// (auto-reply.ts) then wrote straight into `reservation_requests.estimated_price`,
// SKIPPING the real per-night calculation entirely (`upsertReservationRequest`
// only recomputes when the caller leaves `estimated_price` unset). The
// guest was quoted Q800 for a stay that actually totals Q1,200 (Q600 × 2
// corporate nights).
//
// Two separate fixes came out of this: (1) `autoRecordReservation` now
// never trusts a model-supplied `precio` for habitaciones/paquetes at
// all — those two categories are ALWAYS priced here, deterministically,
// never guessed; (2) this function proactively pushes the computed total
// to the guest the moment it's clean and complete, instead of waiting for
// the model to notice `hotelStayEstimate` in its own context (which is
// always one turn stale — computed before the turn that completes it).
// ============================================================

export type StayEstimateStatus =
  | { status: 'incomplete' }
  | { status: 'too_large_group' } // 5+ guests — never auto-priced, by design
  | { status: 'uneven_rooms' } // several rooms, headcount doesn't split evenly — a person prices it
  | { status: 'unpriceable'; reason: 'no_product_match' | 'no_rates' | 'bad_dates' | 'missing_night_rate' }
  | {
      status: 'priced'
      reservationRequestId: string
      text: string
      /** The same figures worded as the LAST message after the bot's
       *  closing reply — no item/dates recap (the close just said them),
       *  and the one mention that a colleague confirms availability. */
      closingText: string
      total: number
    }

/** Sent after a hotel close when there is no fresh total to share. */
export const CLOSE_AVAILABILITY_LINE = 'Un compañero le confirmará la disponibilidad en breve. 😊'
export const CLOSE_AVAILABILITY_AND_TOTAL_LINE = 'Un compañero le confirmará la disponibilidad y el total en breve. 😊'

/**
 * Same underlying data `loadHotelStayEstimate` computes, but as a
 * customer-facing message plus a status the caller can act on —
 * `auto-reply.ts` sends `text` proactively (deduped against
 * `ai_action_log` so an unchanged total is never repeated) and alerts an
 * owner on `unpriceable` (a real gap: a name that should have matched,
 * or rates that are missing) while staying silent on `incomplete` /
 * `too_large_group` (both expected, normal states).
 */
export async function computeStayEstimateStatus(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  currency: string,
  depositPercent = 50,
  /** Business-local YYYY-MM-DD: a stay starting before it is never priced
   *  (test run 2026-09-24 — past dates were quoted and sent). */
  todayISO?: string,
): Promise<StayEstimateStatus> {
  const { data: rr } = await db
    .from('reservation_requests')
    .select('id, category, service_name, product_id, guests, rooms, check_in, check_out, estimated_price')
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .in('category', ['habitaciones', 'paquetes'])
    .not('check_in', 'is', null)
    .not('check_out', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle<ReservationRow>()
  if (!rr || !rr.check_in || !rr.check_out) return { status: 'incomplete' }
  if (!rr.guests || !Number.isInteger(rr.guests) || rr.guests < 1) return { status: 'incomplete' }
  if (todayISO && rr.check_in < todayISO) return { status: 'incomplete' }

  const rooms = roomCount(rr.rooms)
  const perRoom = guestsPerRoom(rr.guests, rr.rooms)
  if (perRoom === null) return { status: 'uneven_rooms' }
  const occupancy = occupancyForGuests(perRoom)
  if (occupancy === null) return { status: 'too_large_group' }

  const productId = await resolveStayProductId(db, accountId, rr)
  if (!productId) return { status: 'unpriceable', reason: 'no_product_match' }

  const { data: rateRows } = await db
    .from('product_rates')
    .select('day_of_week, occupancy, price, date_from, date_to')
    .eq('account_id', accountId)
    .eq('product_id', productId)
  const rates = (rateRows ?? []) as ProductRate[]
  if (rates.length === 0) return { status: 'unpriceable', reason: 'no_rates' }

  const quote = quoteStay(rates, rr.check_in, rr.check_out, occupancy)
  if (quote.nights.length === 0) return { status: 'unpriceable', reason: 'bad_dates' }
  if (quote.missing.length > 0) return { status: 'unpriceable', reason: 'missing_night_rate' }

  const label = (rr.service_name ?? 'la habitación').trim() || 'la habitación'
  const nightsWord = quote.nights.length === 1 ? 'noche' : 'noches'
  const total = quote.total * rooms
  const deposit = estimateDeposit(total, depositPercent)
  // No "a person confirms availability" disclaimer here: the model's own
  // closing already says it once, and repeating it in every system
  // message read as duplicated noise (test run 2026-09-22).
  const text =
    `El total estimado sería de ${formatCurrency(total, currency)} por ${quote.nights.length} ${nightsWord} ` +
    `para ${headcountEs(rr.guests, rooms, perRoom)} en ${label}, del ${formatDateEs(rr.check_in)} al ${formatDateEs(rr.check_out)}. ` +
    `Para apartar se requiere un anticipo estimado de ${formatCurrency(deposit, currency)}.`

  // Same best-effort seed loadHotelStayEstimate does — keeps the Sheet /
  // Panel figure correct even if this exact total was already stored
  // (e.g. from a stale model-supplied guess this now overwrites).
  if (rr.estimated_price == null || Number(rr.estimated_price) !== total) {
    await db.from('reservation_requests').update({ estimated_price: total }).eq('id', rr.id)
  }

  const nightsPart = `${quote.nights.length} ${nightsWord}`
  const peoplePart = rooms > 1 ? headcountEs(rr.guests, rooms, perRoom) : null
  const closingText =
    `El total estimado de su solicitud es de ${formatCurrency(total, currency)} por ${nightsPart}` +
    `${peoplePart ? ` (${peoplePart})` : ''}, con un anticipo de ${formatCurrency(deposit, currency)} para apartarla. ` +
    CLOSE_AVAILABILITY_LINE

  return { status: 'priced', reservationRequestId: rr.id, text, closingText, total }
}
