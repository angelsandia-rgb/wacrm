import { describe, it, expect } from 'vitest'
import {
  stayNights,
  nightsInWindow,
  windowDays,
  computeHotelKpis,
  hotelDaySeries,
  hotelCategoryMix,
  upcomingArrivalsDepartures,
  type HotelReservation,
  type DateWindow,
} from './compute'

function res(overrides: Partial<HotelReservation>): HotelReservation {
  return {
    check_in: null,
    check_out: null,
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
    // denied request created in window — counts toward approval rate, not nights
    res({ check_in: '2026-03-25', check_out: '2026-03-27', estimated_price: 1500, status: 'denied', created_at: '2026-03-19T10:00:00Z' }),
    // pending
    res({ check_in: '2026-04-02', check_out: '2026-04-05', status: 'pending', created_at: '2026-03-28T10:00:00Z' }),
    // a spa request — ignored by the room KPIs
    res({ category: 'spa', estimated_price: 300, created_at: '2026-03-10T10:00:00Z' }),
  ]

  it('rooms = 10 → occupancy, ADR, RevPAR from confirmed room-nights', () => {
    const k = computeHotelKpis(reservations, 10, WINDOW)
    expect(k.roomNights).toBe(5) // 3 + 2
    expect(k.availableRoomNights).toBe(310) // 10 × 31
    expect(k.revenue).toBeCloseTo(4700) // 2700 + 2000, both fully in window
    expect(k.adr).toBeCloseTo(940) // 4700 / 5
    expect(k.occupancy).toBeCloseTo(5 / 310)
    expect(k.revpar).toBeCloseTo(4700 / 310)
    expect(k.guests).toBe(5) // 2 + 3 (both check in inside March)
  })

  it('requests + approval rate + LOS + lead time (created-in-window)', () => {
    const k = computeHotelKpis(reservations, 10, WINDOW)
    expect(k.requests).toBe(4) // 4 room requests created in March (spa excluded)
    expect(k.requestsApproved).toBe(2)
    expect(k.requestsDenied).toBe(1)
    expect(k.requestsPending).toBe(1)
    expect(k.approvalRate).toBeCloseTo(2 / 3) // 2 approved / 3 decided
    expect(k.avgLengthOfStay).toBeCloseTo(2.5) // (3 + 2) / 2
    expect(k.avgLeadTimeDays).toBeCloseTo((8 + 2) / 2) // 03-05→03-13=8, 03-18→03-20=2
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
  it('spreads a stay across its nights and buckets requests by creation day', () => {
    const s = hotelDaySeries(
      [res({ check_in: '2026-03-02', check_out: '2026-03-05', estimated_price: 300, created_at: '2026-03-01T09:00:00Z' })],
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
    expect(s.find((p) => p.day === '2026-03-01')!.requests).toBe(1)
  })
})

describe('hotelCategoryMix', () => {
  it('groups created-in-window requests + revenue by category, ordered', () => {
    const mix = hotelCategoryMix(
      [
        res({ category: 'habitaciones', estimated_price: 900 }),
        res({ category: 'habitaciones', estimated_price: 900 }),
        res({ category: 'spa', estimated_price: 300 }),
        res({ category: 'eventos', estimated_price: 5000, created_at: '2026-01-01T00:00:00Z' }), // out of window
      ],
      WINDOW,
    )
    expect(mix).toEqual([
      { category: 'habitaciones', requests: 2, revenue: 1800 },
      { category: 'spa', requests: 1, revenue: 300 },
    ])
  })
})

describe('upcomingArrivalsDepartures', () => {
  it('counts approved check-ins / check-outs in the next 7 days', () => {
    const from = new Date(2026, 2, 10) // 2026-03-10
    const r = upcomingArrivalsDepartures(
      [
        res({ check_in: '2026-03-12', check_out: '2026-03-15', guests: 2 }), // arrival in range
        res({ check_in: '2026-03-09', check_out: '2026-03-14', guests: 4 }), // departure in range, arrival not
        res({ check_in: '2026-03-20', check_out: '2026-03-25' }), // both out of range
        res({ check_in: '2026-03-13', check_out: '2026-03-14', status: 'pending' }), // pending → ignored
      ],
      from,
      7,
    )
    expect(r.arrivals).toBe(1)
    expect(r.departures).toBe(2) // 2026-03-15 and 2026-03-14 both fall in [03-10, 03-17)
    expect(r.arrivalGuests).toBe(2)
  })
})
