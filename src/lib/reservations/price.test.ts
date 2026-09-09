import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { estimateStayPrice, resolveStayProductId } from './price'

// 2026-09-09 is a Wednesday. Couple rate Wed–Thu = 500, Fri = 700.
const RATES = [
  { day_of_week: 'wed', occupancy: 'couple', price: 500, date_from: null, date_to: null },
  { day_of_week: 'thu', occupancy: 'couple', price: 500, date_from: null, date_to: null },
  { day_of_week: 'fri', occupancy: 'couple', price: 700, date_from: null, date_to: null },
]

function makeDb(o: { rates?: unknown[]; products?: { id: string; name: string }[] }) {
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
        then: (resolve: (r: unknown) => unknown) => resolve(result),
      }
      return chain
    },
  }
  return db as unknown as SupabaseClient
}

describe('resolveStayProductId', () => {
  it('returns null without a product_id or service_name', async () => {
    expect(await resolveStayProductId(makeDb({}), 'a', {})).toBeNull()
  })

  it('matches a unique service_name (exact, then substring)', async () => {
    const db = makeDb({ products: [{ id: 'p1', name: 'Master Suite Deluxe' }, { id: 'p2', name: 'Cabaña' }] })
    expect(await resolveStayProductId(db, 'a', { service_name: 'master suite deluxe' })).toBe('p1')
    expect(await resolveStayProductId(db, 'a', { service_name: 'Master Suite' })).toBe('p1')
  })

  it('returns null when the name is ambiguous', async () => {
    const db = makeDb({ products: [{ id: 'p1', name: 'Suite Deluxe' }, { id: 'p2', name: 'Suite Familiar' }] })
    expect(await resolveStayProductId(db, 'a', { service_name: 'Suite' })).toBeNull()
  })
})

describe('estimateStayPrice', () => {
  const STAY = { service_name: 'Master Suite Deluxe', guests: 2, check_in: '2026-09-09', check_out: '2026-09-11' }

  it('sums the per-night couple tariffs for a clean stay', async () => {
    const db = makeDb({ rates: RATES, products: [{ id: 'p1', name: 'Master Suite Deluxe' }] })
    expect(await estimateStayPrice(db, 'a', STAY)).toBe(1000) // Wed 500 + Thu 500
  })

  it('returns null when a night has no published rate', async () => {
    const db = makeDb({ rates: RATES, products: [{ id: 'p1', name: 'Master Suite Deluxe' }] })
    // 09-11 → 09-13 covers Fri (700) + Sat (no rate)
    expect(await estimateStayPrice(db, 'a', { ...STAY, check_in: '2026-09-11', check_out: '2026-09-13' })).toBeNull()
  })

  it('returns null without both dates or a usable guest count', async () => {
    const db = makeDb({ rates: RATES, products: [{ id: 'p1', name: 'Master Suite Deluxe' }] })
    expect(await estimateStayPrice(db, 'a', { ...STAY, check_out: null })).toBeNull()
    expect(await estimateStayPrice(db, 'a', { ...STAY, guests: 0 })).toBeNull()
  })

  it('returns null when the product has no rates', async () => {
    const db = makeDb({ rates: [], products: [{ id: 'p1', name: 'Master Suite Deluxe' }] })
    expect(await estimateStayPrice(db, 'a', STAY)).toBeNull()
  })
})
