import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { estimateStayPrice, resolveStayProductId, estimateDeposit, guestsPerRoom, roomCount } from './price'

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

describe('estimateDeposit', () => {
  it('computes the exact percentage of the total', () => {
    expect(estimateDeposit(800, 50)).toBe(400)
    expect(estimateDeposit(1000, 30)).toBe(300)
  })

  it('rounds to the nearest whole unit', () => {
    expect(estimateDeposit(500, 33)).toBe(165) // 165.0
    expect(estimateDeposit(333, 50)).toBe(167) // 166.5 → 167
  })
})

describe('several rooms (B43)', () => {
  it('splits the total headcount evenly or gives up', () => {
    expect(guestsPerRoom(4, 2)).toBe(2)
    expect(guestsPerRoom(4, null)).toBe(4)
    expect(guestsPerRoom(5, 2)).toBeNull() // how they split is the guest's call
    expect(guestsPerRoom(1, 2)).toBeNull()
    expect(roomCount(null)).toBe(1)
    expect(roomCount(3)).toBe(3)
  })

  it('prices every room at the per-room occupancy', async () => {
    const db = makeDb({ rates: RATES, products: [{ id: 'p1', name: 'Suite Premium' }] })
    // Wed + Thu nights, 2 rooms × couple rate 500 = 2000
    expect(
      await estimateStayPrice(db, 'a', {
        service_name: 'Suite Premium', guests: 4, rooms: 2, check_in: '2026-09-09', check_out: '2026-09-11',
      }),
    ).toBe(2000)
    // 4 people in ONE couple-only room → no tier → a person prices it
    expect(
      await estimateStayPrice(db, 'a', {
        service_name: 'Suite Premium', guests: 4, check_in: '2026-09-09', check_out: '2026-09-11',
      }),
    ).toBeNull()
  })
})
