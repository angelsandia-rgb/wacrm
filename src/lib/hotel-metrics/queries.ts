import type { SupabaseClient } from '@supabase/supabase-js'
import type { HotelReservation } from './compute'

/** Client-safe mirror of `categorySlugFromName` in
 *  `@/lib/reservations/upsert` (that module pulls server-only deps).
 *  We only need to recognise the room category here. */
function isRoomCategoryName(name: string | undefined): boolean {
  return /habitac|room|cuarto/.test((name ?? '').trim().toLowerCase())
}

// Client-side loaders for the hotel Panel / KPIs. RLS scopes every
// query to the signed-in user's account. Volume is small (a hotel's
// reservation ledger), so client aggregation is fine — same call as
// the rest of the dashboard.

type DB = SupabaseClient

// Keyset pagination works even when PostgREST caps responses below our
// requested page size. Never turn a failed or truncated query into zero KPIs.
async function loadRows(db: DB, table: string, columns: string, filter?: string) {
  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null
  for (;;) {
    let query = db.from(table).select(`id, ${columns}`).order('id').limit(500)
    if (filter) query = query.or(filter)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw error
    if (!data?.length) return rows
    const page = data as unknown as Record<string, unknown>[]
    rows.push(...page)
    if (rows.length > 50_000) throw new Error('Hotel metrics require server aggregation above 50000 rows')
    const next = page[page.length - 1].id as string
    if (!next || next === cursor) throw new Error('Hotel metrics pagination did not advance')
    cursor = next
  }
}

export interface HotelMetricsData {
  reservations: HotelReservation[]
  /** Active room products (category → "habitaciones"). `null` when the
   *  catalog has no room category at all — occupancy can't be computed. */
  roomCount: number | null
}

export async function loadHotelMetrics(db: DB, sinceIso: string): Promise<HotelMetricsData> {
  const [reservationRows, productRows, categoryRows] = await Promise.all([
    loadRows(db, 'reservation_requests', 'check_in, check_out, use_date, guests, estimated_price, status, created_at, category',
      // Anything whose stay OR whose request date could touch the widest
      // window the UI offers. `sinceIso` already covers the range +
      // its comparison period; stays reach a bit further out, so we also
      // keep future check-ins.
      `created_at.gte.${sinceIso},check_out.gte.${sinceIso.slice(0, 10)},use_date.gte.${sinceIso.slice(0, 10)}`),
    loadRows(db, 'products', 'category_id, is_active'),
    loadRows(db, 'product_categories', 'name'),
  ])

  const reservations = (reservationRows as unknown as HotelReservation[]).map((r) => ({
    ...r,
    estimated_price:
      r.estimated_price != null ? Number(r.estimated_price) : null,
    guests: r.guests != null ? Number(r.guests) : null,
  }))

  const categoryById = new Map<string, string>(
    (categoryRows as { id: string; name: string }[]).map((c) => [c.id, c.name]),
  )
  const products = productRows as {
    id: string
    category_id: string | null
    is_active: boolean
  }[]
  const hasRoomCategory = [...categoryById.values()].some(isRoomCategoryName)
  const roomCount = hasRoomCategory
    ? products.filter(
        (p) =>
          p.is_active &&
          p.category_id != null &&
          isRoomCategoryName(categoryById.get(p.category_id)),
      ).length
    : null

  return { reservations, roomCount }
}
