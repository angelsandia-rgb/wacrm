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

export interface HotelMetricsData {
  reservations: HotelReservation[]
  /** Active room products (category → "habitaciones"). `null` when the
   *  catalog has no room category at all — occupancy can't be computed. */
  roomCount: number | null
}

export async function loadHotelMetrics(db: DB, sinceIso: string): Promise<HotelMetricsData> {
  const [resvRes, productsRes, categoriesRes] = await Promise.all([
    db
      .from('reservation_requests')
      .select('check_in, check_out, guests, estimated_price, status, created_at, category')
      // Anything whose stay OR whose request date could touch the widest
      // window the UI offers. `sinceIso` already covers the range +
      // its comparison period; stays reach a bit further out, so we also
      // keep future check-ins.
      .or(`created_at.gte.${sinceIso},check_out.gte.${sinceIso.slice(0, 10)}`)
      .limit(5000),
    db.from('products').select('id, category_id, is_active'),
    db.from('product_categories').select('id, name'),
  ])

  const reservations = ((resvRes.data ?? []) as HotelReservation[]).map((r) => ({
    ...r,
    estimated_price:
      r.estimated_price != null ? Number(r.estimated_price) : null,
    guests: r.guests != null ? Number(r.guests) : null,
  }))

  const categoryById = new Map<string, string>(
    ((categoriesRes.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]),
  )
  const products = (productsRes.data ?? []) as {
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
