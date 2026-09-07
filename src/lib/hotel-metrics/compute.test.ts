import { describe, it, expect } from 'vitest'
import {
  stayNights,
  nightsInWindow,
  windowDays,
  computeHotelKpis,
  hotelDaySeries,
  hotelCategoryBreakdown,
  upcomingArrivalsDepartures,
  type HotelReservation,
  type DateWindow,
} from './compute'

function res(overrides: Partial<HotelReservation>): HotelReservation {
  return {
    check_in: null,
    check_out: null,
    use_date: null,
    guests: null,
    estimated_price: null,
    status: 'approved',
    created_at: '2026-03-10T12:00:00Z',
    category: 'habitaciones',
    ...overrides,
  }
}

const WINDOW: DateWindow = {
  start: new Date(2026, 2, 1), // 2026-03-01 local
  end: new Date(2026, 3, 1), // 2026-04-01 local (exclusive) → 31 days
}

describe('stayNights', () => {
  it('counts whole nights, check-out exclusive', () => {
    expect(stayNights('2026-03-13', '2026-03-16')).toBe(3)
    expect(stayNights('2026-03-13', '2026-03-14')).toBe(1)
  })
  it('0 for a bad/empty range', () => {
    expect(stayNights(null, '2026-03-16')).toBe(0)
    expect(stayNights('2026-03-16', '2026-03-13')).toBe(0)
    expect(stayNights('2026-03-13', '2026-03-13')).toBe(0)
  })
})

describe('nightsInWindow', () => {
  it('clips a stay to the window', () => {
    // stay 2026-02-27 → 2026-03-03, window starts 03-01 → 2 nights inside (01, 02)
    expect(nightsInWindow('2026-02-27', '2026-03-03', WINDOW)).toBe(2)
  })
  it('a fully-inside stay counts all its nights', () => {
    expect(nightsInWindow('2026-03-10', '2026-03-14', WINDOW)).toBe(4)
  })
  it('a stay entirely outside counts 0', () => {
    expect(nightsInWindow('2026-05-01', '2026-05-05', WINDOW)).toBe(0)
  })
})

describe('windowDays', () => {
  it('counts whole local days', () => {
    expect(windowDays(WINDOW)).toBe(31)
  })
})

describe('computeHotelKpis', () => {
  const reservations: HotelReservation[] = [
    // 3-night stay fully in March, priced 2700 → 900/night, 2 guests
    res({ check_in: '2026-03-13', check_out: '2026-03-16', guests: 2, estimated_price: 2700, created_at: '2026-03-05T10:00:00Z' }),
    // 2-night stay in March, priced 2000 → 1000/night
    res({ check_in: '2026-03-20', check_out: '2026-03-22', guests: 3, estimated_price: 2000, created_at: '2026-03-18T10:00:00Z' }),
    // denied request created in window — counts toward approval rate, but
    // is excluded from every "live" figure (nights, revenue, stay, lead time)
    res({ check_in: '2026-03-25', check_out: '2026-03-27', estimated_price: 1500, status: 'denied', created_at: '2026-03-19T10:00:00Z' }),
    // pending — still "live" (no approve/deny screen exists), so it feeds
    // stay / lead-time / est-revenue; its stay is outside the window though
    res({ check_in: '2026-04-02', check_out: '2026-04-05', status: 'pending', created_at: '2026-03-28T10:00:00Z' }),
    // a spa request — counts toward demand, ignored by the ROOM KPIs
    res({ category: 'spa', estimated_price: 300, guests: 1, created_at: '2026-03-10T10:00:00Z' }),
  ]

  it('rooms only feed occupancy, ADR, RevPAR, room revenue', () => {
    const k = computeHotelKpis(reservations, 10, WINDOW)
    expect(k.roomNights).toBe(5) // 3 + 2
    expect(k.availableRoomNights).toBe(310) // 10 × 31
    expect(k.revenue).toBeCloseTo(4700) // 2700 + 2000, both fully in window (rooms only)
    expect(k.adr).toBeCloseTo(940) // 4700 / 5
    expect(k.occupancy).toBeCloseTo(5 / 310)
    expect(k.revpar).toBeCloseTo(4700 / 310)
    expect(k.guests).toBe(5) // 2 + 3 rooms (spa has no service date → not counted)
  })

  it('requests / approval / est. revenue span EVERY category', () => {
    const k = computeHotelKpis(reservations, 10, WINDOW)
    expect(k.requests).toBe(5) // 4 room requests + 1 spa, all created in March
    expect(k.requestsApproved).toBe(3) // 2 rooms + spa
    expect(k.requestsDenied).toBe(1)
    expect(k.requestsPending).toBe(1)
    expect(k.approvalRate).toBeCloseTo(3 / 4) // 3 approved / 4 decided
    expect(k.estRevenue).toBeCloseTo(5000) // 2700 + 2000 + 300 (live, all cats; pending room has no price)
    expect(k.avgLengthOfStay).toBeCloseTo(8 / 3) // (3 + 2 + 3) / 3 — incl. the live pending room
    expect(k.avgLeadTimeDays).toBeCloseTo((8 + 2 + 5) / 3) // 03-05→03-13=8, 03-18→03-20=2, 03-28→04-02=5
  })

  it('a hotel whose requests are all still pending is NOT a blank Panel', () => {
    // The real-world default: no one approves/denies, everything sits at
    // `pending`. Every demand figure must still populate.
    const window: DateWindow = {
      start: new Date(2026, 4, 1),
      end: new Date(2026, 5, 1), // exclusive → all of May is "inside"
    }
    const allPending: HotelReservation[] = [
      res({ category: 'habitaciones', status: 'pending', check_in: '2026-05-20', check_out: '2026-05-23', guests: 2, estimated_price: 1500, created_at: '2026-05-10T12:00:00Z' }),
      res({ category: 'spa', status: 'pending', use_date: '2026-05-12', guests: 3, created_at: '2026-05-10T12:00:00Z' }),
      res({ category: 'eventos', status: 'pending', use_date: '2026-05-28', guests: 20, created_at: '2026-05-10T12:00:00Z' }),
    ]
    const k = computeHotelKpis(allPending, 4, window)
    expect(k.requests).toBe(3)
    expect(k.requestsPending).toBe(3)
    expect(k.approvalRate).toBeNull() // nothing decided
    expect(k.estRevenue).toBeCloseTo(1500)
    expect(k.avgLengthOfStay).toBeCloseTo(3)
    expect(k.roomNights).toBe(3) // the pending room's 3 nights still count
    expect(k.occupancy).toBeCloseTo(3 / (4 * 31))
  })

  it('no room count → occupancy / RevPAR are null but ADR still works', () => {
    const k = computeHotelKpis(reservations, null, WINDOW)
    expect(k.availableRoomNights).toBeNull()
    expect(k.occupancy).toBeNull()
    expect(k.revpar).toBeNull()
    expect(k.adr).toBeCloseTo(940)
  })

  it('prorates revenue for a stay that straddles the window edge', () => {
    const straddle: HotelReservation[] = [
      res({ check_in: '2026-02-27', check_out: '2026-03-03', estimated_price: 4000 }), // 4 nights total, 2 in window
    ]
    const k = computeHotelKpis(straddle, 5, WINDOW)
    expect(k.roomNights).toBe(2)
    expect(k.revenue).toBeCloseTo(2000) // 4000 * 2/4
  })
})

describe('hotelDaySeries', () => {
  it('spreads a room stay across its nights and buckets EVERY-category requests by creation day', () => {
    const s = hotelDaySeries(
      [
        res({ check_in: '2026-03-02', check_out: '2026-03-05', estimated_price: 300, created_at: '2026-03-01T09:00:00Z' }),
        res({ category: 'spa', created_at: '2026-03-01T18:00:00Z' }),
        res({ category: 'eventos', created_at: '2026-03-06T10:00:00Z' }),
      ],
      WINDOW,
    )
    expect(s).toHaveLength(31)
    const d2 = s.find((p) => p.day === '2026-03-02')!
    const d4 = s.find((p) => p.day === '2026-03-04')!
    const d5 = s.find((p) => p.day === '2026-03-05')!
    expect(d2.roomNights).toBe(1)
    expect(d2.revenue).toBeCloseTo(100)
    expect(d4.roomNights).toBe(1) // check-out day is NOT a night
    expect(d5.roomNights).toBe(0)
    // room request + spa request both created on 03-01
    expect(s.find((p) => p.day === '2026-03-01')!.requests).toBe(2)
    expect(s.find((p) => p.day === '2026-03-06')!.requests).toBe(1) // eventos
  })
})

describe('hotelCategoryBreakdown', () => {
  it('always returns the five categories in order, even at zero', () => {
    const b = hotelCategoryBreakdown([], WINDOW)
    expect(b.map((r) => r.category)).toEqual([
      'habitaciones',
      'spa',
      'actividades',
      'paquetes',
      'eventos',
    ])
    expect(b.every((r) => r.requests === 0 && r.approvalRate === null)).toBe(true)
  })

  it('tallies requests, status, approval rate, est. revenue and guests per category', () => {
    const b = hotelCategoryBreakdown(
      [
        res({ category: 'habitaciones', status: 'approved', estimated_price: 900, guests: 2 }),
        res({ category: 'habitaciones', status: 'denied', estimated_price: 900 }),
        res({ category: 'spa', status: 'approved', estimated_price: 300, guests: 1 }),
        res({ category: 'spa', status: 'pending', estimated_price: 300 }),
        res({ category: 'eventos', status: 'approved', estimated_price: 5000, created_at: '2026-01-01T00:00:00Z' }), // out of window
      ],
      WINDOW,
    )
    const rooms = b.find((r) => r.category === 'habitaciones')!
    expect(rooms).toMatchObject({ requests: 2, approved: 1, denied: 1, estRevenue: 900, guests: 2 })
    expect(rooms.approvalRate).toBeCloseTo(0.5)

    const spa = b.find((r) => r.category === 'spa')!
    // est. revenue / guests span live rows (approved + pending); only the
    // approve/deny counters split them out
    expect(spa).toMatchObject({ requests: 2, approved: 1, pending: 1, estRevenue: 600, guests: 1 })
    expect(spa.approvalRate).toBe(1) // 1 approved / 1 decided (pending is not "decided")

    const eventos = b.find((r) => r.category === 'eventos')!
    expect(eventos).toMatchObject({ requests: 0, estRevenue: 0 }) // out-of-window row excluded
  })

  it('folds an unknown category into "otros" only when present', () => {
    const withOther = hotelCategoryBreakdown([res({ category: 'transporte', status: 'approved' })], WINDOW)
    expect(withOther.map((r) => r.category)).toContain('otros')
    expect(withOther.find((r) => r.category === 'otros')!.requests).toBe(1)
  })
})

describe('upcomingArrivalsDepartures', () => {
  it('counts live (not-denied) check-ins / check-outs / services in the next 7 days', () => {
    const from = new Date(2026, 2, 10) // 2026-03-10
    const r = upcomingArrivalsDepartures(
      [
        res({ check_in: '2026-03-12', check_out: '2026-03-15', guests: 2 }), // arrival + departure in range
        res({ check_in: '2026-03-09', check_out: '2026-03-14', guests: 4 }), // departure in range, arrival not
        res({ check_in: '2026-03-20', check_out: '2026-03-25' }), // both out of range
        res({ check_in: '2026-03-13', check_out: '2026-03-14', status: 'pending' }), // pending still counts
        res({ check_in: '2026-03-13', check_out: '2026-03-14', status: 'denied' }), // denied → ignored
        res({ category: 'spa', use_date: '2026-03-12', guests: 3 }), // service in range
        res({ category: 'eventos', use_date: '2026-03-30' }), // service out of range
        res({ category: 'actividades', use_date: '2026-03-15', status: 'pending' }), // pending still counts
      ],
      from,
      7,
    )
    expect(r.arrivals).toBe(2) // 03-12 (approved) + 03-13 (pending)
    expect(r.departures).toBe(3) // 03-15, 03-14 (approved) and 03-14 (pending) all in [03-10, 03-17)
    expect(r.arrivalGuests).toBe(2) // only the 03-12 arrival carries guests
    expect(r.services).toBe(2) // spa 03-12 + activity 03-15 (pending)
    expect(r.serviceGuests).toBe(3) // spa carries 3; the activity has none
  })
})
