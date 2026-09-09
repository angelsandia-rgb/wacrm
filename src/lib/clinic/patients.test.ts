import { describe, it, expect } from 'vitest'
import {
  buildPatientAggregates,
  matchesPatientFilter,
  isPatientFilter,
  type PatientListRow,
} from './patients'

const NOW = '2026-03-10T00:00:00Z'
const TODAY = '2026-03-09'

describe('buildPatientAggregates', () => {
  it('sums value, counts visits, takes the latest visit date', () => {
    const agg = buildPatientAggregates(
      [
        { patient_id: 'p1', visit_date: '2026-01-10', amount: '300.00', follow_up_date: null },
        { patient_id: 'p1', visit_date: '2026-02-15', amount: 250, follow_up_date: null },
        { patient_id: 'p2', visit_date: '2026-02-01', amount: null, follow_up_date: null },
      ],
      [],
      NOW,
      TODAY,
    )
    expect(agg.get('p1')).toMatchObject({ visit_count: 2, total_value: 550, last_visit_date: '2026-02-15' })
    expect(agg.get('p2')).toMatchObject({ visit_count: 1, total_value: 0, last_visit_date: '2026-02-01' })
  })

  it('next_appointment_at = soonest live upcoming appointment; past / cancelled ignored', () => {
    const agg = buildPatientAggregates(
      [],
      [
        { patient_id: 'p1', scheduled_at: '2026-03-20T15:00:00Z', status: 'SCHEDULED' },
        { patient_id: 'p1', scheduled_at: '2026-03-12T15:00:00Z', status: 'CONFIRMED' },
        { patient_id: 'p1', scheduled_at: '2026-03-11T15:00:00Z', status: 'CANCELLED' },
        { patient_id: 'p2', scheduled_at: '2026-01-01T15:00:00Z', status: 'SCHEDULED' }, // past
      ],
      NOW,
      TODAY,
    )
    expect(agg.get('p1')?.next_appointment_at).toBe('2026-03-12T15:00:00Z')
    // p2 has only a past appointment and no visits → no aggregate entry
    // (the list falls back to the empty aggregate).
    expect(agg.get('p2')).toBeUndefined()
  })

  it('follow_up_due only when a past recommended date AND no live upcoming appointment', () => {
    const agg = buildPatientAggregates(
      [
        { patient_id: 'due', visit_date: '2026-02-01', amount: 100, follow_up_date: '2026-03-05' },
        { patient_id: 'booked', visit_date: '2026-02-01', amount: 100, follow_up_date: '2026-03-05' },
        { patient_id: 'future', visit_date: '2026-02-01', amount: 100, follow_up_date: '2026-04-01' },
      ],
      [{ patient_id: 'booked', scheduled_at: '2026-03-25T15:00:00Z', status: 'SCHEDULED' }],
      NOW,
      TODAY,
    )
    expect(agg.get('due')?.follow_up_due).toBe(true)
    expect(agg.get('booked')?.follow_up_due).toBe(false) // has an upcoming appt
    expect(agg.get('future')?.follow_up_due).toBe(false) // date not reached
  })
})

describe('matchesPatientFilter', () => {
  const row = (over: Partial<PatientListRow>): PatientListRow => ({
    id: 'x',
    contact_id: 'c',
    name: 'N',
    phone: null,
    email: null,
    source: null,
    created_at: NOW,
    last_visit_date: null,
    next_appointment_at: null,
    visit_count: 0,
    total_value: 0,
    follow_up_due: false,
    ...over,
  })

  it('new = 0..1 visits, returning = 2+', () => {
    expect(matchesPatientFilter(row({ visit_count: 1 }), 'new')).toBe(true)
    expect(matchesPatientFilter(row({ visit_count: 2 }), 'new')).toBe(false)
    expect(matchesPatientFilter(row({ visit_count: 2 }), 'returning')).toBe(true)
  })

  it('upcoming / no_future are complementary on next_appointment_at', () => {
    const withAppt = row({ next_appointment_at: '2026-03-20T15:00:00Z' })
    expect(matchesPatientFilter(withAppt, 'upcoming')).toBe(true)
    expect(matchesPatientFilter(withAppt, 'no_future')).toBe(false)
    expect(matchesPatientFilter(row({}), 'no_future')).toBe(true)
  })

  it('follow_up_due filter reads the flag; all matches everything', () => {
    expect(matchesPatientFilter(row({ follow_up_due: true }), 'follow_up_due')).toBe(true)
    expect(matchesPatientFilter(row({ follow_up_due: false }), 'follow_up_due')).toBe(false)
    expect(matchesPatientFilter(row({}), 'all')).toBe(true)
  })
})

describe('isPatientFilter', () => {
  it('narrows', () => {
    expect(isPatientFilter('returning')).toBe(true)
    expect(isPatientFilter('bogus')).toBe(false)
    expect(isPatientFilter(null)).toBe(false)
  })
})
