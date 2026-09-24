import { formatCurrency } from '@/lib/currency'
import { formatDateEs } from '@/lib/products/rates'
import type { ReservationCategory } from './upsert'

/** The reservation fields a follow-up nudge cares about — a subset of
 *  the full `reservation_requests` row (or an empty snapshot when no
 *  row exists yet for this category/product). `service_name` and
 *  `estimated_price` aren't used by `missingReservationFields` (never
 *  "missing" — a summary just omits them if absent) but do feed
 *  `reservationSummaryText`. */
export interface ReservationFieldSnapshot {
  category: ReservationCategory
  guests?: number | null
  check_in?: string | null
  check_out?: string | null
  use_date?: string | null
  hall?: string | null
  service_name?: string | null
  estimated_price?: number | null
}

const DATE_RANGE_CATEGORIES = new Set<ReservationCategory>(['habitaciones', 'paquetes'])
const USE_DATE_CATEGORIES = new Set<ReservationCategory>(['spa', 'actividades', 'eventos'])

/**
 * Which pieces of information are still missing to confirm this
 * reservation, in plain Spanish, for the deterministic "¿le gustaría
 * confirmar?" nudge sent after a photo or a quote (hotel vertical
 * only — see [[proactive-reservation-followup]]). Every category needs
 * a guest count; `habitaciones`/`paquetes` need a stay date RANGE,
 * `spa`/`actividades`/`eventos` need a single-use date, and `eventos`
 * additionally needs the hall. Returns `[]` when nothing is missing —
 * the caller sends a plain confirmation invite instead.
 */
export function missingReservationFields(row: ReservationFieldSnapshot): string[] {
  const missing: string[] = []
  if (DATE_RANGE_CATEGORIES.has(row.category)) {
    if (!row.check_in || !row.check_out) missing.push('las fechas de entrada y salida')
  } else if (USE_DATE_CATEGORIES.has(row.category)) {
    if (!row.use_date) missing.push('la fecha')
  }
  if (!row.guests) missing.push('el número de personas')
  if (row.category === 'eventos' && !row.hall) missing.push('el salón que le interesa')
  return missing
}

/** Warm, varied closing invitations — the same canned sentence every time
 *  read like a form (Angel, 2026-09-24: "súper amable, textos variados,
 *  elocuente y cálida"). `{missing}` is the joined list of what's still
 *  needed. Picked by `variant`, so a caller can rotate them. */
const FOLLOW_UP_WITH_MISSING = [
  '¿Le gustaría reservarla? Con mucho gusto se la dejo lista; solo necesito {missing}. 😊',
  'Si le gusta, será un placer apartársela. ¿Me comparte {missing}?',
  '¡Nos encantaría recibirle! Para dejar su solicitud lista, ¿me indica {missing}?',
  'Cuando guste la reservamos. Para avanzar, ¿me ayuda con {missing}?',
]
const FOLLOW_UP_COMPLETE = [
  '¿Le gustaría que confirmemos la reservación? Con gusto se la dejamos lista.',
  '¿Desea que dejemos su solicitud lista? Será un placer atenderle.',
  'Si le parece bien, con mucho gusto dejamos su reservación lista. ¿Le confirmo?',
]

const pick = (options: string[], variant: number) =>
  options[((variant % options.length) + options.length) % options.length]

/** Renders the missing-field list (see `missingReservationFields`) into
 *  the actual WhatsApp text sent after a photo or quote. */
export function reservationFollowUpText(missing: string[], variant = 0): string {
  if (missing.length === 0) return pick(FOLLOW_UP_COMPLETE, variant)
  const joined =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} y ${missing[missing.length - 1]}`
  return pick(FOLLOW_UP_WITH_MISSING, variant).replace('{missing}', joined)
}

/**
 * A one-line recap of everything captured for this reservation —
 * service, dates/guests/hall, and the estimated total if one is on
 * file — ending in the confirmation ask. Only meaningful once
 * `missingReservationFields` returns `[]`; see
 * `buildReservationFollowUpMessage` for the combined decision.
 */
export function reservationSummaryText(row: ReservationFieldSnapshot, currency: string): string {
  const bits: string[] = []
  if (row.service_name) bits.push(row.service_name)
  if (row.check_in && row.check_out) bits.push(`del ${formatDateEs(row.check_in)} al ${formatDateEs(row.check_out)}`)
  else if (row.use_date) bits.push(formatDateEs(row.use_date))
  if (row.guests) bits.push(`${row.guests} ${row.guests === 1 ? 'persona' : 'personas'}`)
  if (row.category === 'eventos' && row.hall) bits.push(row.hall)
  if (row.estimated_price != null && row.estimated_price > 0) {
    bits.push(`total estimado ${formatCurrency(row.estimated_price, currency)}`)
  }
  const detail = bits.length > 0 ? bits.join(', ') : 'su reservación'
  return `Perfecto, esto sería: ${detail}. ¿Confirmamos la reservación?`
}

/** Single entry point for both post-photo and post-quote follow-ups:
 *  the missing-fields ask while something's still needed, the full
 *  recap (`reservationSummaryText`) once nothing is. */
export function buildReservationFollowUpMessage(
  row: ReservationFieldSnapshot,
  currency: string,
  variant = 0,
): string {
  const missing = missingReservationFields(row)
  return missing.length > 0 ? reservationFollowUpText(missing, variant) : reservationSummaryText(row, currency)
}
