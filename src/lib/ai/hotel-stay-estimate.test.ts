import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadHotelStayEstimate } from './hotel-stay-estimate'

// 2026-09-09 is a Wednesday. Couple rate Mon–Thu = 500, Fri–Sun = 700.
const RATES = [
  { day_of_week: 'wed', occupancy: 'couple', price: 500, date_from: null, date_to: null },
  { day_of_week: 'thu', occupancy: 'couple', price: 500, date_from: null, date_to: null },
  { day_of_week: 'fri', occupancy: 'couple', price: 700, date_from: null, date_to: null },
  { day_of_week: 'wed', occupancy: 'standard', price: 300, date_from: null, date_to: null },
]

interface Opts {
  reservation?: Record<string, unknown> | null
  rates?: unknown[]
  products?: { id: string; name: string }[]
  updates?: { id: string; patch: Record<string, unknown> }[]
}

function makeDb(o: Opts) {
  o.updates ??= []
  const db = {
    from(table: string) {
      const result =
        table === 'product_rates'
          ? { data: o.rates ?? [], error: null }
          : table === 'products'
            ? { data: o.products ?? [], error: null }
            : { data: null, error: null }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: o.reservation ?? null, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_c: string, id: string) => ({
            is: () => {
              o.updates!.push({ id, patch })
              return Promise.resolve({ error: null })
            },
          }),
        }),
        then: (resolve: (r: unknown) => unknown) => resolve(result),
      }
      return chain
    },
  }
  return db as unknown as SupabaseClient
}

const RESV = {
  id: 'rr-1',
  category: 'habitaciones',
  service_name: 'Master Suite Deluxe',
  product_id: null,
  guests: 2,
  check_in: '2026-09-09',
  check_out: '2026-09-10',
  estimated_price: null,
}

describe('loadHotelStayEstimate', () => {
  it('computes a 1-night couple stay from the published tariffs', async () => {
    const res = await loadHotelStayEstimate(
      makeDb({ reservation: RESV, rates: RATES, products: [{ id: 'p1', name: 'Master Suite Deluxe' }] }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(res).toBeTruthy()
    expect(res).toContain('Master Suite Deluxe')
    expect(res).toContain('1 noche')
    expect(res).toMatch(/Total estimado: .*500/)
    expect(res).toContain('estimado')
  })

  it('back-fills reservation_requests.estimated_price when every night priced', async () => {
    const updates: { id: string; patch: Record<string, unknown> }[] = []
    await loadHotelStayEstimate(
      makeDb({ reservation: RESV, rates: RATES, products: [{ id: 'p1', name: 'Master Suite Deluxe' }], updates }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(updates).toEqual([{ id: 'rr-1', patch: { estimated_price: 500 } }])
  })

  it('does NOT back-fill when a night has no published rate', async () => {
    const updates: { id: string; patch: Record<string, unknown> }[] = []
    const res = await loadHotelStayEstimate(
      makeDb({
        reservation: { ...RESV, check_out: '2026-09-13' }, // 09,10,11,12; sat (09-12) has no couple/standard rate
        rates: RATES,
        products: [{ id: 'p1', name: 'Master Suite Deluxe' }],
        updates,
      }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(res).toContain('sin tarifa publicada')
    expect(updates).toEqual([])
  })

  it('returns null with no pending reservation row', async () => {
    expect(await loadHotelStayEstimate(makeDb({ reservation: null }), 'acct-1', 'cv-1', 'GTQ')).toBeNull()
  })

  it('returns null when the product has no rates', async () => {
    const res = await loadHotelStayEstimate(
      makeDb({ reservation: RESV, rates: [], products: [{ id: 'p1', name: 'Master Suite Deluxe' }] }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(res).toBeNull()
  })

  it("returns null when service_name matches no product", async () => {
    const res = await loadHotelStayEstimate(
      makeDb({ reservation: RESV, rates: RATES, products: [{ id: 'p1', name: 'Cabaña del Bosque' }] }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(res).toBeNull()
  })
})
