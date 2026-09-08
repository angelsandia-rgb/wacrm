import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { nightsBetween, occupancyForGuests } from '@/lib/products/rates'

// ============================================================
// Create-or-extend a hotel "solicitud" (reservation / service request),
// then fire `reservation.updated` so its Google Sheets category row is
// (re)written. Shared by the internal CRUD route, the public catalog
// form, the AI `record_reservation` tool and the quote builder.
// ============================================================

export type ReservationCategory =
  | 'habitaciones'
  | 'spa'
  | 'actividades'
  | 'paquetes'
  | 'eventos'

export const RESERVATION_CATEGORIES: ReservationCategory[] = [
  'habitaciones',
  'spa',
  'actividades',
  'paquetes',
  'eventos',
]

/**
 * Map a catalog category *name* (as seeded by the hotel kit — "Habitaciones",
 * "Spa", "Actividades al aire libre", "Paquetes", "Eventos", or a rename
 * that still reads the same) to a reservation slug. `null` when it isn't
 * one of the five hotel service kinds (a generic-account category, an
 * uncategorised product).
 */
export function categorySlugFromName(name: string | null | undefined): ReservationCategory | null {
  const n = (name ?? '').trim().toLowerCase()
  if (!n) return null
  if (/habitac|room|cuarto/.test(n)) return 'habitaciones'
  if (/\bspa\b|masaj/.test(n)) return 'spa'
  if (/actividad|activit|tour|excursi/.test(n)) return 'actividades'
  if (/paquete|package|combo/.test(n)) return 'paquetes'
  if (/evento|event|sal[oó]n|boda|banquete/.test(n)) return 'eventos'
  return null
}

export type ReservationStatus = 'pending' | 'approved' | 'denied'
export type ReservationSource = 'manual' | 'catalog' | 'ai_chat' | 'quote_builder'

export interface ReservationInput {
  category: ReservationCategory
  contact_id?: string | null
  conversation_id?: string | null
  product_id?: string | null
  quote_id?: string | null
  service_name?: string | null
  guests?: number | null
  check_in?: string | null
  check_out?: string | null
  use_date?: string | null
  duration_minutes?: number | null
  hall?: string | null
  decoration?: string | null
  estimated_price?: number | null
  status?: ReservationStatus
  notes?: string | null
  source?: ReservationSource
}

/** Fields a caller may set. `undefined` = leave as-is; an explicit
 *  value (incl. `null`) is written. */
const SETTABLE_KEYS = [
  'contact_id',
  'conversation_id',
  'product_id',
  'quote_id',
  'service_name',
  'guests',
  'check_in',
  'check_out',
  'use_date',
  'duration_minutes',
  'hall',
  'decoration',
  'estimated_price',
  'status',
  'notes',
] as const

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate the `reservations[]` a quote-builder submit attaches to
 * `POST /api/quotes` — one per hotel line the builder captured stay /
 * service details for. Silently drops entries with a bad category (a
 * non-hotel line shouldn't produce one anyway).
 */
export function parseQuoteReservations(raw: unknown): ReservationInput[] {
  if (!Array.isArray(raw)) return []
  const out: ReservationInput[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const category = e.category
    if (
      typeof category !== 'string' ||
      !RESERVATION_CATEGORIES.includes(category as ReservationCategory)
    ) {
      continue
    }
    const num = (v: unknown): number | undefined => {
      if (v === undefined || v === null || v === '') return undefined
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : undefined
    }
    const date = (v: unknown): string | undefined =>
      typeof v === 'string' && ISO_DATE.test(v) ? v : undefined

    const input: ReservationInput = {
      category: category as ReservationCategory,
      source: 'quote_builder',
    }
    if (typeof e.product_id === 'string' && e.product_id) input.product_id = e.product_id
    if (typeof e.service_name === 'string' && e.service_name) input.service_name = e.service_name
    const guests = num(e.guests)
    if (guests !== undefined) input.guests = Math.round(guests)
    const minutes = num(e.duration_minutes)
    if (minutes !== undefined) input.duration_minutes = Math.round(minutes)
    const price = num(e.estimated_price)
    if (price !== undefined) input.estimated_price = price
    const checkIn = date(e.check_in)
    if (checkIn) input.check_in = checkIn
    const checkOut = date(e.check_out)
    if (checkOut) input.check_out = checkOut
    const useDate = date(e.use_date)
    if (useDate) input.use_date = useDate

    out.push(input)
  }
  return out
}

/**
 * Upsert a reservation request and fire `reservation.updated`.
 *
 * With `conversation_id` set it matches on `(conversation_id, category)`
 * so the AI keeps building the same row across turns — only the fields
 * actually present in `input` are written, so a sparse later turn never
 * blanks an earlier fact. Without it (catalog / quote builder) it always
 * inserts.
 *
 * `admin` must be a service-role client. Returns the reservation id, or
 * `null` on a write failure (best-effort, like the Sheets dispatch).
 */
export async function upsertReservationRequest(
  admin: SupabaseClient,
  accountId: string,
  input: ReservationInput,
): Promise<string | null> {
  const patch: Record<string, unknown> = {}
  for (const k of SETTABLE_KEYS) {
    const v = input[k as keyof ReservationInput]
    if (v !== undefined) patch[k] = v
  }

  let id: string | null = null

  if (input.conversation_id) {
    const { data: existing } = await admin
      .from('reservation_requests')
      .select('id')
      .eq('account_id', accountId)
      .eq('conversation_id', input.conversation_id)
      .eq('category', input.category)
      .maybeSingle<{ id: string }>()
    if (existing) {
      id = existing.id
      if (Object.keys(patch).length > 0) {
        const { error } = await admin
          .from('reservation_requests')
          .update(patch)
          .eq('id', id)
        if (error) {
          console.error('[reservations] update failed:', error.message)
          return null
        }
      }
    }
  }

  if (!id) {
    const { data, error } = await admin
      .from('reservation_requests')
      .insert({
        account_id: accountId,
        category: input.category,
        source: input.source ?? 'manual',
        ...patch,
      })
      .select('id')
      .single()
    if (error || !data) {
      console.error('[reservations] insert failed:', error?.message)
      return null
    }
    id = data.id as string
  }

  await syncReservationToContactFields(admin, accountId, id)

  await dispatchWebhookEvent(admin, accountId, 'reservation.updated', {
    reservation_id: id,
    source: input.source ?? 'manual',
  })
  return id
}

const OCCUPANCY_LABEL_ES: Record<ReturnType<typeof occupancyForGuests>, string> = {
  standard: 'Individual',
  couple: 'Pareja',
  group: 'Grupo',
}

/**
 * Mirror a room / package reservation into the contact's hotel custom
 * fields (seeded by the `hotel` starter kit) so the deals tab and the
 * "Requerimientos" Google Sheet — both built from `contact_custom_values`
 * — stop coming up blank. "Noches" is derived here; nothing else fills it.
 *
 * Best-effort: a hotel that renamed or deleted a field just gets fewer
 * columns filled. Never throws, never blocks the reservation write.
 */
async function syncReservationToContactFields(
  admin: SupabaseClient,
  accountId: string,
  reservationId: string,
): Promise<void> {
  try {
    const { data: r } = await admin
      .from('reservation_requests')
      .select('category, contact_id, service_name, guests, check_in, check_out')
      .eq('id', reservationId)
      .maybeSingle<{
        category: string
        contact_id: string | null
        service_name: string | null
        guests: number | null
        check_in: string | null
        check_out: string | null
      }>()
    if (!r || !r.contact_id) return
    if (r.category !== 'habitaciones' && r.category !== 'paquetes') return

    const nights =
      r.check_in && r.check_out ? nightsBetween(r.check_in, r.check_out).length : 0

    // Field name (as seeded by src/lib/verticals) → value for this reservation.
    const wanted: Record<string, string> = {}
    if (r.check_in) wanted['Fecha de entrada'] = r.check_in
    if (r.check_out) wanted['Fecha de salida'] = r.check_out
    if (nights > 0) wanted['Noches'] = String(nights)
    if (r.guests && r.guests > 0) {
      wanted['Huéspedes'] = String(r.guests)
      wanted['Ocupación'] = OCCUPANCY_LABEL_ES[occupancyForGuests(r.guests)]
    }
    if (r.service_name) {
      wanted[r.category === 'paquetes' ? 'Paquete' : 'Habitación'] = r.service_name
    }
    if (Object.keys(wanted).length === 0) return

    const { data: fields } = await admin
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId)
    if (!fields || fields.length === 0) return

    const byName = new Map(
      (fields as { id: string; field_name: string }[]).map((f) => [
        f.field_name.trim().toLowerCase(),
        f.id,
      ]),
    )

    const rows = Object.entries(wanted)
      .map(([name, value]) => {
        const fieldId = byName.get(name.toLowerCase())
        return fieldId
          ? { contact_id: r.contact_id, custom_field_id: fieldId, value }
          : null
      })
      .filter((x): x is { contact_id: string; custom_field_id: string; value: string } => x !== null)
    if (rows.length === 0) return

    const { error } = await admin
      .from('contact_custom_values')
      .upsert(rows, { onConflict: 'contact_id,custom_field_id' })
    if (error) {
      console.error('[reservations] contact custom-field sync failed:', error.message)
    }
  } catch (err) {
    console.error(
      '[reservations] contact custom-field sync threw:',
      err instanceof Error ? err.message : err,
    )
  }
}
