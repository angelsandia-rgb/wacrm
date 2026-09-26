import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { estimateStayPrice, resolveStayProductId, estimateDeposit, guestsPerRoom, priceStay, roomCount, totalGuests } from './price'
import type { ProductRate } from '@/lib/products/rates'

// 2026-09-09 is a Wednesday. Couple rate Wed–Thu = 500, Fri = 700.
const RATES = [
  { day_of_week: 'wed', occupancy: 'couple', price: 500, date_from: null, date_to: null },
  { day_of_week: 'thu', occupancy: 'couple', price: 500, date_from: null, date_to: null },
  { day_of_week: 'fri', occupancy: 'couple', price: 700, date_from: null, date_to: null },
]

function makeDb(o: { rates?: unknown[]; products?: { id: string; name: string }[]; maxGuests?: number | null }) {
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
        maybeSingle: () => Promise.resolve({ data: { max_guests: o.maxGuests ?? null }, error: null }),
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

// Junior Suite Familiar, Villa San Ricardo (2026-09-25): adult tiers
// Sun–Thu (corporativa) / Fri–Sat (recreativa), child 6–12 Q175 / Q200,
// high season (24/12–01/01) quad Q1,200 + child Q200. Capacity 5.
function juniorRates(): ProductRate[] {
  const rows: ProductRate[] = []
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu'] as const
  const weekend = ['fri', 'sat'] as const
  for (const d of weekday) {
    rows.push({ day_of_week: d, occupancy: 'couple', price: 600, date_from: null, date_to: null })
    rows.push({ day_of_week: d, occupancy: 'quad', price: 1160, date_from: null, date_to: null })
    rows.push({ day_of_week: d, occupancy: 'child', price: 175, date_from: null, date_to: null })
  }
  for (const d of weekend) {
    rows.push({ day_of_week: d, occupancy: 'couple', price: 800, date_from: null, date_to: null })
    rows.push({ day_of_week: d, occupancy: 'quad', price: 1500, date_from: null, date_to: null })
    rows.push({ day_of_week: d, occupancy: 'child', price: 200, date_from: null, date_to: null })
  }
  for (const d of [...weekday, ...weekend]) {
    rows.push({ day_of_week: d, occupancy: 'quad', price: 1200, date_from: '2026-12-24', date_to: '2027-01-01' })
    rows.push({ day_of_week: d, occupancy: 'child', price: 200, date_from: '2026-12-24', date_to: '2027-01-01' })
  }
  return rows
}

describe('priceStay — children (migration 160)', () => {
  // 2026-11-12 Thu (corporativa) → 11-13 Fri (recreativa) → 11-14.
  const STAY = { check_in: '2026-11-12', check_out: '2026-11-14' }

  it('5 people: 4 adults at the quad rate + one 8-year-old at the child rate of each night', () => {
    const p = priceStay(juniorRates(), { ...STAY, guests: 5, adults: 4, children_ages: [8] }, 5)
    expect(p.kind).toBe('quoted')
    if (p.kind !== 'quoted') return
    // Thu 1160 + 175, Fri 1500 + 200
    expect(p.total).toBe(1160 + 175 + 1500 + 200)
    expect(p.children).toMatchObject({ adults: 4, charged: 1, free: 0 })
  })

  it('children under 6 are free; 2 adults price at the couple tier', () => {
    const p = priceStay(juniorRates(), { ...STAY, adults: 2, children_ages: [3, 10] }, 5)
    expect(p.kind === 'quoted' && p.total).toBe(600 + 175 + 800 + 200)
  })

  it('high season uses the season child rate', () => {
    const p = priceStay(juniorRates(), { check_in: '2026-12-31', check_out: '2027-01-01', adults: 4, children_ages: [7] }, 5)
    expect(p.kind === 'quoted' && p.total).toBe(1200 + 200)
  })

  it('a room with child rates waits for the adults/children split', () => {
    expect(priceStay(juniorRates(), { ...STAY, guests: 5 }, 5).kind).toBe('incomplete')
  })

  it('over capacity, 5 adults, or a 13+ child are never auto-priced', () => {
    expect(priceStay(juniorRates(), { ...STAY, adults: 4, children_ages: [8, 9] }, 5).kind).toBe('too_large_group')
    expect(priceStay(juniorRates(), { ...STAY, adults: 5 }, 6).kind).toBe('too_large_group')
    expect(priceStay(juniorRates(), { ...STAY, adults: 2, children_ages: [14] }, 5)).toEqual({ kind: 'needs_person', reason: 'older_child' })
  })

  it('without max_guests a room with child rates still stops at 4 people', () => {
    expect(priceStay(juniorRates(), { ...STAY, adults: 4, children_ages: [8] }, null).kind).toBe('too_large_group')
  })

  it('a room without child rates keeps pricing the whole headcount by tier', () => {
    const noChild = juniorRates().filter((r) => r.occupancy !== 'child')
    const p = priceStay(noChild, { ...STAY, guests: 4 }, null)
    expect(p.kind === 'quoted' && p.total).toBe(1160 + 1500)
  })

  it('an adults/children split that does not add up to the headcount waits for the missing ages', () => {
    expect(priceStay(juniorRates(), { ...STAY, guests: 5, adults: 2, children_ages: [8, 10] }, 5).kind).toBe('incomplete')
  })

  it('totalGuests: the headcount, else the adults/children split', () => {
    expect(totalGuests({ adults: 4, children_ages: [8] })).toBe(5)
    expect(totalGuests({ guests: 5, adults: 4, children_ages: [8] })).toBe(5)
    expect(totalGuests({ guests: 3 })).toBe(3)
    expect(totalGuests({})).toBeNull()
  })
})

describe('estimateStayPrice — children', () => {
  it('prices the Junior Suite for 4 adults + 1 child with max_guests 5', async () => {
    const db = makeDb({ rates: juniorRates(), products: [{ id: 'p1', name: 'Junior Suite Familiar' }], maxGuests: 5 })
    expect(
      await estimateStayPrice(db, 'a', {
        service_name: 'Junior Suite Familiar', guests: 5, adults: 4, children_ages: [8], check_in: '2026-11-12', check_out: '2026-11-14',
      }),
    ).toBe(1160 + 175 + 1500 + 200)
  })
})
