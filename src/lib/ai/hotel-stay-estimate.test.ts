import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadHotelStayEstimate, computeStayEstimateStatus } from './hotel-stay-estimate'

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
  it('does not quote an unavailable explicit product', async () => {
    expect(await loadHotelStayEstimate(makeDb({ reservation: { ...RESV, product_id: 'inactive' },
      rates: RATES, products: [],
    }), 'acct-1', 'cv-1', 'GTQ')).toBeNull()
  })
  it('does not invent guests or pick an ambiguous room', async () => {
    for (const reservation of [{ ...RESV, guests: null }, { ...RESV, service_name: 'Suite' }]) {
      expect(await loadHotelStayEstimate(makeDb({ reservation, rates: RATES, products: [
        { id: 'p1', name: 'Master Suite Deluxe' }, { id: 'p2', name: 'Suite Familiar' },
      ] }), 'acct-1', 'cv-1', 'GTQ')).toBeNull()
    }
  })
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

  it('includes the deposit amount, computed from the account deposit_percent, when the total is complete', async () => {
    const res = await loadHotelStayEstimate(
      makeDb({ reservation: RESV, rates: RATES, products: [{ id: 'p1', name: 'Master Suite Deluxe' }] }),
      'acct-1',
      'cv-1',
      'GTQ',
      50,
    )
    expect(res).toContain('anticipo')
    expect(res).toContain('50%')
    expect(res).toMatch(/anticipo.*250/) // 50% of 500
  })

  it('respects a non-default deposit_percent', async () => {
    const res = await loadHotelStayEstimate(
      makeDb({ reservation: RESV, rates: RATES, products: [{ id: 'p1', name: 'Master Suite Deluxe' }] }),
      'acct-1',
      'cv-1',
      'GTQ',
      30,
    )
    expect(res).toContain('30%')
    expect(res).toMatch(/anticipo.*150/) // 30% of 500
  })

  it('does NOT mention a deposit when a night has no published rate (partial subtotal)', async () => {
    const res = await loadHotelStayEstimate(
      makeDb({
        reservation: { ...RESV, check_out: '2026-09-13' },
        rates: RATES,
        products: [{ id: 'p1', name: 'Master Suite Deluxe' }],
      }),
      'acct-1',
      'cv-1',
      'GTQ',
      50,
    )
    expect(res).not.toContain('anticipo')
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
    expect(res).toContain('Subtotal de noches con tarifa')
    expect(res).not.toContain('Total estimado:')
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

// Real incident, 2026-09-20: a guest's Suite Clásica (Wed check-in, Thu
// check-out — both nights the CORPORATE rate) got quoted Q800 instead of
// the real Q1,200 (Q600 × 2), because the model's servicio="Suite Clásica"
// matched TWO real products ambiguously and the model then supplied its
// own guessed `precio` instead of leaving pricing to the system.
// `computeStayEstimateStatus` is the fix's other half: a discriminated
// status the caller (auto-reply.ts) can act on — proactively send on
// 'priced', alert an owner on 'unpriceable', stay quiet otherwise.
function makeDb2(o: Opts) {
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
        maybeSingle: async () => ({ data: o.reservation ?? null, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_c: string, id: string) => {
            o.updates!.push({ id, patch })
            return Promise.resolve({ error: null })
          },
        }),
        then: (resolve: (r: unknown) => unknown) => resolve(result),
      }
      return chain
    },
  }
  return db as unknown as SupabaseClient
}

describe('computeStayEstimateStatus', () => {
  it('returns unpriceable/no_product_match on an ambiguous service_name — the real 2026-09-20 bug', async () => {
    const res = await computeStayEstimateStatus(
      makeDb2({
        reservation: { ...RESV, service_name: 'Suite Clásica' },
        rates: RATES,
        products: [
          { id: 'p1', name: 'Suite Clásica (Individual o Pareja)' },
          { id: 'p2', name: 'Suite Clásica Doble' },
        ],
      }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(res).toEqual({ status: 'unpriceable', reason: 'no_product_match' })
  })

  it('computes the correct mixed-rate total and text when the name resolves cleanly', async () => {
    // check_in Wed, check_out Fri (exclusive) = Wed(500) + Thu(500) = 1000.
    const res = await computeStayEstimateStatus(
      makeDb2({
        reservation: { ...RESV, check_out: '2026-09-11', service_name: 'Master Suite Deluxe' },
        rates: RATES,
        products: [{ id: 'p1', name: 'Master Suite Deluxe' }],
      }),
      'acct-1',
      'cv-1',
      'GTQ',
      50,
    )
    expect(res.status).toBe('priced')
    if (res.status === 'priced') {
      expect(res.total).toBe(1000)
      expect(res.text).toContain('1,000')
      expect(res.text).toContain('Master Suite Deluxe')
      expect(res.text).toContain('anticipo')
      expect(res.reservationRequestId).toBe('rr-1')
    }
  })

  it('returns incomplete without dates or guests', async () => {
    expect(
      await computeStayEstimateStatus(makeDb2({ reservation: null }), 'acct-1', 'cv-1', 'GTQ'),
    ).toEqual({ status: 'incomplete' })
    expect(
      await computeStayEstimateStatus(
        makeDb2({ reservation: { ...RESV, guests: null } }),
        'acct-1',
        'cv-1',
        'GTQ',
      ),
    ).toEqual({ status: 'incomplete' })
  })

  it('returns too_large_group for 5+ guests — never auto-priced, by design', async () => {
    const res = await computeStayEstimateStatus(
      makeDb2({ reservation: { ...RESV, guests: 6 }, rates: RATES, products: [{ id: 'p1', name: 'Master Suite Deluxe' }] }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(res).toEqual({ status: 'too_large_group' })
  })

  it('returns unpriceable/no_rates when the product has no published rates', async () => {
    const res = await computeStayEstimateStatus(
      makeDb2({ reservation: RESV, rates: [], products: [{ id: 'p1', name: 'Master Suite Deluxe' }] }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(res).toEqual({ status: 'unpriceable', reason: 'no_rates' })
  })

  it('returns unpriceable/missing_night_rate (never a silent partial total) when a night has no published rate', async () => {
    const res = await computeStayEstimateStatus(
      makeDb2({
        reservation: { ...RESV, check_out: '2026-09-13' }, // includes Sat, which has no couple/standard rate
        rates: RATES,
        products: [{ id: 'p1', name: 'Master Suite Deluxe' }],
      }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(res).toEqual({ status: 'unpriceable', reason: 'missing_night_rate' })
  })

  it('backfills reservation_requests.estimated_price with the correct total, overwriting a stale/wrong one', async () => {
    const updates: { id: string; patch: Record<string, unknown> }[] = []
    await computeStayEstimateStatus(
      makeDb2({
        // Simulates the bug: a wrong model-guessed price already stored.
        reservation: { ...RESV, check_out: '2026-09-11', estimated_price: 800 },
        rates: RATES,
        products: [{ id: 'p1', name: 'Master Suite Deluxe' }],
        updates,
      }),
      'acct-1',
      'cv-1',
      'GTQ',
    )
    expect(updates).toEqual([{ id: 'rr-1', patch: { estimated_price: 1000 } }])
  })
})

describe('several rooms (B43)', () => {
  const PRODUCTS = [{ id: 'p1', name: 'Master Suite Deluxe' }]
  it('prices every room at its per-room occupancy', async () => {
    const res = await computeStayEstimateStatus(
      makeDb({ reservation: { ...RESV, guests: 4, rooms: 2 }, rates: RATES, products: PRODUCTS }),
      'acct-1', 'cv-1', 'GTQ',
    )
    expect(res.status).toBe('priced')
    if (res.status !== 'priced') return
    expect(res.total).toBe(1000) // 2 rooms × couple Wed 500
    expect(res.text).toContain('2 habitaciones × 2 personas')
    // The after-close wording: no item/dates recap, one availability line.
    expect(res.closingText).toMatch(/^El total estimado de su solicitud es de .*1.?000 por 1 noche \(2 habitaciones × 2 personas\), con un anticipo de .*500 para apartarla\. Un compañero le confirmará la disponibilidad en breve\. 😊$/)
    expect(res.closingText).not.toContain('Master Suite Deluxe')
    const summary = await loadHotelStayEstimate(
      makeDb({ reservation: { ...RESV, guests: 4, rooms: 2 }, rates: RATES, products: PRODUCTS }),
      'acct-1', 'cv-1', 'GTQ',
    )
    expect(summary).toMatch(/Total estimado \(2 habitaciones\): .*1.?000/)
  })
  it('leaves an uneven split to a person', async () => {
    const res = await computeStayEstimateStatus(
      makeDb({ reservation: { ...RESV, guests: 5, rooms: 2 }, rates: RATES, products: PRODUCTS }),
      'acct-1', 'cv-1', 'GTQ',
    )
    expect(res.status).toBe('uneven_rooms')
  })
})
