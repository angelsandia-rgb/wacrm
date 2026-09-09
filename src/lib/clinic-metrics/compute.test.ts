import { describe, it, expect } from 'vitest'
import {
  appointmentsByDay,
  classifyPatients,
  computeAppointments,
  computeAttention,
  computeConversions,
  computeHumanResponse,
  computeRevenue,
  upcomingAppointments,
  type AppointmentRow,
  type VisitRow,
} from './compute'

const W = { from: '2026-03-01T06:00:00.000Z', to: '2026-04-01T06:00:00.000Z' } // March, GT
const PREV = { from: '2026-02-01T06:00:00.000Z', to: '2026-03-01T06:00:00.000Z' }

const visit = (patient_id: string, visit_date: string, amount: number | null, follow_up_date: string | null = null): VisitRow => ({
  patient_id,
  visit_date,
  amount,
  follow_up_date,
})
const appt = (over: Partial<AppointmentRow>): AppointmentRow => ({
  id: 'a',
  scheduled_at: '2026-03-10T15:00:00.000Z',
  status: 'SCHEDULED',
  confirmation_status: 'pending',
  ...over,
})

describe('computeRevenue', () => {
  it('sums in-window visits and computes the delta vs the previous period', () => {
    const visits = [
      visit('p1', '2026-03-05', 300),
      visit('p1', '2026-03-20', 200),
      visit('p2', '2026-02-15', 1000), // prev period
    ]
    const r = computeRevenue(visits, W, PREV)
    expect(r.total).toBe(500)
    expect(r.previousPeriod).toBe(1000)
    expect(r.percentageChange).toBeCloseTo(-50)
  })
  it('percentageChange is null when the previous period was zero but now is not', () => {
    expect(computeRevenue([visit('p1', '2026-03-05', 300)], W, PREV).percentageChange).toBeNull()
  })
})

describe('classifyPatients', () => {
  it('new = first-ever visit inside the window; returning = had one before', () => {
    const all = [
      visit('new1', '2026-03-03', 300), // first visit in March → new
      visit('ret1', '2026-01-10', 500), // before window
      visit('ret1', '2026-03-15', 250), // returned in March
      visit('ret1', '2026-03-25', 250),
    ]
    const { newPatients, returningPatients } = classifyPatients(all, W)
    expect(newPatients).toEqual({ count: 1, revenue: 300 })
    expect(returningPatients).toEqual({ count: 1, revenue: 500 })
  })
})

describe('computeAppointments', () => {
  it('counts total / confirmed / no-shows and the confirmation rate', () => {
    const appts = [
      appt({ scheduled_at: '2026-03-02T15:00:00Z', confirmation_status: 'confirmed', status: 'CONFIRMED' }),
      appt({ scheduled_at: '2026-03-03T15:00:00Z', confirmation_status: 'no_response', status: 'NO_SHOW' }),
      appt({ scheduled_at: '2026-03-04T15:00:00Z', confirmation_status: 'not_required', status: 'COMPLETED' }),
      appt({ scheduled_at: '2026-05-01T15:00:00Z' }), // outside window
    ]
    const r = computeAppointments(appts, W)
    expect(r).toMatchObject({ total: 3, confirmed: 1, noShows: 1 })
    expect(r.confirmationRate).toBeCloseTo(50) // 1 confirmed / 2 that required confirmation
    expect(r.noShowRate).toBeCloseTo(33.333, 1)
  })
})

describe('computeConversions', () => {
  it('funnel counts + rates', () => {
    const r = computeConversions(
      100,
      [appt({ scheduled_at: '2026-03-05T15:00:00Z' }), appt({ scheduled_at: '2026-03-06T15:00:00Z' })],
      [visit('p1', '2026-03-07', 1)],
      W,
    )
    expect(r).toMatchObject({ conversations: 100, bookedAppointments: 2, completedVisits: 1 })
    expect(r.bookingConversionRate).toBeCloseTo(2)
    expect(r.completedConversionRate).toBeCloseTo(1)
  })
})

describe('computeHumanResponse', () => {
  it('measures customer-inbound → first human reply, mean seconds', () => {
    const r = computeHumanResponse([
      { conversation_id: 'c1', sender_type: 'customer', ai_generated: false, created_at: '2026-03-01T10:00:00Z' },
      { conversation_id: 'c1', sender_type: 'bot', ai_generated: true, created_at: '2026-03-01T10:00:30Z' }, // AI, ignored
      { conversation_id: 'c1', sender_type: 'agent', ai_generated: false, created_at: '2026-03-01T10:02:00Z' }, // human → 120s
      { conversation_id: 'c2', sender_type: 'customer', ai_generated: false, created_at: '2026-03-02T09:00:00Z' },
      { conversation_id: 'c2', sender_type: 'agent', ai_generated: false, created_at: '2026-03-02T09:04:00Z' }, // 240s
    ])
    expect(r.sampleSize).toBe(2)
    expect(r.averageSeconds).toBeCloseTo(180)
  })
  it('null when no measurable pair', () => {
    expect(computeHumanResponse([{ conversation_id: 'c', sender_type: 'customer', ai_generated: false, created_at: 'x' }])).toEqual({
      averageSeconds: null,
      sampleSize: 0,
    })
  })
})

describe('computeAttention', () => {
  const NOW = '2026-03-10T12:00:00.000Z'
  const TODAY = '2026-03-10'
  it('unconfirmed upcoming, recent no-shows, follow-ups due without a future appt', () => {
    const appts = [
      appt({ id: 'u', scheduled_at: '2026-03-15T15:00:00Z', status: 'SCHEDULED', confirmation_status: 'pending', patient_id: 'pX' }),
      appt({ id: 'ns', scheduled_at: '2026-03-08T15:00:00Z', status: 'NO_SHOW', confirmation_status: 'no_response' }),
      appt({ id: 'future', scheduled_at: '2026-03-20T15:00:00Z', status: 'SCHEDULED', confirmation_status: 'confirmed', patient_id: 'booked' }),
    ]
    const visits = [
      visit('due', '2026-02-01', 100, '2026-03-05'), // due, no future appt → counts
      visit('booked', '2026-02-01', 100, '2026-03-01'), // due but has a future appt → not counted
    ]
    const r = computeAttention({ appts, visits, conversationsWaiting: 3, nowISO: NOW, todayISODate: TODAY })
    expect(r).toEqual({
      unconfirmedAppointments: 1,
      noShows: 1,
      followUps: 1,
      conversationsWaiting: 3,
    })
  })
})

describe('upcomingAppointments', () => {
  it('future + live only, soonest first, capped', () => {
    const appts = [
      appt({ id: 'past', scheduled_at: '2026-03-01T15:00:00Z' }),
      appt({ id: 'b', scheduled_at: '2026-03-20T15:00:00Z' }),
      appt({ id: 'a', scheduled_at: '2026-03-12T15:00:00Z' }),
      appt({ id: 'cancelled', scheduled_at: '2026-03-13T15:00:00Z', status: 'CANCELLED' }),
    ]
    const r = upcomingAppointments(appts, '2026-03-10T00:00:00Z', 5)
    expect(r.map((x) => x.id)).toEqual(['a', 'b'])
  })
})

describe('appointmentsByDay', () => {
  it('buckets by clinic-local day with no gaps', () => {
    const w = { from: '2026-03-09T06:00:00.000Z', to: '2026-03-12T06:00:00.000Z' } // 3 GT days
    const appts = [
      appt({ scheduled_at: '2026-03-09T15:00:00Z', status: 'CONFIRMED' }),
      appt({ scheduled_at: '2026-03-09T18:00:00Z', status: 'COMPLETED' }),
      appt({ scheduled_at: '2026-03-11T14:00:00Z', status: 'NO_SHOW' }),
    ]
    const r = appointmentsByDay(appts, w, 'America/Guatemala')
    expect(r.map((d) => d.date)).toEqual(['2026-03-09', '2026-03-10', '2026-03-11'])
    expect(r[0]).toMatchObject({ scheduled: 2, confirmed: 1, completed: 1, noShows: 0 })
    expect(r[1]).toMatchObject({ scheduled: 0 })
    expect(r[2]).toMatchObject({ scheduled: 1, noShows: 1 })
  })
})
