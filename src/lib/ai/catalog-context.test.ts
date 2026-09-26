import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCatalogContext } from './catalog-context'

function makeDb(
  products: { id?: string; name: string; price: number; description: string | null }[],
  defaultCurrency: string | undefined = 'USD',
  opts: { vertical?: string; rates?: unknown[]; maxGuests?: Record<string, number> } = {},
) {
  const db = {
    from: (table: string) => {
      if (table === 'products') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: products, error: null }),
          // capacity read (migration 160)
          in: () =>
            Promise.resolve({
              data: Object.entries(opts.maxGuests ?? {}).map(([id, max_guests]) => ({ id, max_guests })),
              error: null,
            }),
        }
        return chain
      }
      if (table === 'product_rates') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => Promise.resolve({ data: opts.rates ?? [], error: null }),
        }
        return chain
      }
      // accounts
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  default_currency: defaultCurrency,
                  industry_vertical: opts.vertical ?? 'generic',
                },
                error: null,
              }),
          }),
        }),
      }
    },
  }
  return db as unknown as SupabaseClient
}

describe('loadCatalogContext', () => {
  it('returns null when the account has no active products', async () => {
    const res = await loadCatalogContext(makeDb([]), 'acct-1')
    expect(res).toBeNull()
  })

  it('formats each product with its currency-formatted price', async () => {
    // Assert on structure, not the localized currency symbol: Intl
    // renders GTQ as "Q150" under an es-* runtime locale but "GTQ 150"
    // under en-* (the CI runner), and formatCurrency passes `undefined`
    // for the locale. Same reason the USD test below only checks "(".
    const res = await loadCatalogContext(
      makeDb([{ name: 'Camisa', price: 150, description: null }], 'GTQ'),
      'acct-1',
    )
    expect(res).toHaveLength(1)
    expect(res![0]).toMatch(/^- Camisa \(.*150\)/)
  })

  it('appends a short description when present', async () => {
    const res = await loadCatalogContext(
      makeDb([{ name: 'Camisa', price: 150, description: 'Algodón 100%' }], 'GTQ'),
      'acct-1',
    )
    expect(res).toHaveLength(1)
    expect(res![0]).toContain('— Algodón 100%')
  })

  it('truncates a long description instead of blowing up the prompt', async () => {
    const longDesc = 'x'.repeat(200)
    const res = await loadCatalogContext(
      makeDb([{ name: 'Camisa', price: 150, description: longDesc }], 'GTQ'),
      'acct-1',
    )
    expect(res![0].length).toBeLessThan(longDesc.length)
    expect(res![0]).toContain('…')
  })

  it('shows a room rate structure for a hotel account', async () => {
    const res = await loadCatalogContext(
      makeDb(
        [{ id: 'r1', name: 'Hab 101', price: 0, description: 'Vista jardín' }],
        'GTQ',
        {
          vertical: 'hotel',
          rates: [
            { product_id: 'r1', day_of_week: 'mon', occupancy: 'standard', price: 800, date_from: null, date_to: null },
            { product_id: 'r1', day_of_week: 'tue', occupancy: 'standard', price: 800, date_from: null, date_to: null },
            { product_id: 'r1', day_of_week: 'fri', occupancy: 'standard', price: 1200, date_from: null, date_to: null },
            { product_id: 'r1', day_of_week: 'mon', occupancy: 'couple', price: 950, date_from: null, date_to: null },
            { product_id: 'r1', day_of_week: 'fri', occupancy: 'group', price: 1600, date_from: null, date_to: null },
          ],
        },
      ),
      'acct-1',
    )
    expect(res).toHaveLength(1)
    expect(res![0]).toContain('Hab 101:')
    // comma/space in "1,200" varies by runtime locale — match loosely
    expect(res![0]).toMatch(/Lun–Mar .*800/)
    expect(res![0]).toMatch(/Vie .*1.?200/)
    expect(res![0]).toMatch(/pareja Lun .*950/)
    expect(res![0]).toMatch(/grupo Vie .*1.?600/)
    expect(res![0]).toContain('— Vista jardín')
  })

  it('lists each season separately, with its dates and guest tiers', async () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
    const season = (occupancy: string, price: number, date_from: string, date_to: string) =>
      days.map((day_of_week) => ({ product_id: 'r1', day_of_week, occupancy, price, date_from, date_to }))
    const res = await loadCatalogContext(
      makeDb([{ id: 'r1', name: 'Suite Premium', price: 0, description: null }], 'GTQ', {
        vertical: 'hotel',
        rates: [
          ...season('standard', 450, '2026-12-24', '2027-01-01'),
          ...season('couple', 870, '2026-12-24', '2027-01-01'),
          ...season('couple', 870, '2027-03-21', '2027-03-27'),
        ],
      }),
      'acct-1',
    )
    expect(res![0]).toMatch(/temporada 24\/12\/2026–01\/01\/2027: Lun–Dom .*450 · pareja Lun–Dom .*870/)
    expect(res![0]).toMatch(/temporada 21\/03\/2027–27\/03\/2027: pareja Lun–Dom .*870/)
  })

  it('a hotel product with no rates still shows its base price', async () => {
    const res = await loadCatalogContext(
      makeDb([{ id: 's1', name: 'Masaje', price: 250, description: null }], 'GTQ', {
        vertical: 'hotel',
        rates: [],
      }),
      'acct-1',
    )
    expect(res![0]).toMatch(/^- Masaje \(.*250\)/)
  })

  it('falls back to USD when the account has no default_currency', async () => {
    const res = await loadCatalogContext(
      makeDb([{ name: 'Widget', price: 10, description: null }], undefined),
      'acct-1',
    )
    expect(res).toHaveLength(1)
    expect(res![0]).toContain('- Widget (')
    expect(res![0]).toContain('10')
  })
})

describe('loadCatalogContext — room capacity and child rate (migration 160)', () => {
  it('shows the capacity and the child rate so the model asks adults/children', async () => {
    const db = makeDb([{ id: 'p1', name: 'Junior Suite Familiar', price: 1160, description: null }], 'GTQ', {
      vertical: 'hotel',
      rates: [
        { product_id: 'p1', day_of_week: 'thu', occupancy: 'quad', price: 1160, date_from: null, date_to: null },
        { product_id: 'p1', day_of_week: 'thu', occupancy: 'child', price: 175, date_from: null, date_to: null },
      ],
      maxGuests: { p1: 5 },
    })
    const lines = await loadCatalogContext(db, 'acct')
    expect(lines?.[0]).toContain('niño 6–12 años (c/u)')
    expect(lines?.[0]).toContain('capacidad máx. 5 personas (adultos + niños)')
  })
})
