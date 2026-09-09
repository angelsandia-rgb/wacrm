import { describe, it, expect } from 'vitest'
import { computeFreeSlots, overlapsBusy, type FreeSlotQuery } from './availability'

// Clinic in America/Guatemala (UTC-6, no DST). 2026-03-09 is a Monday.
const TZ = 'America/Guatemala'

function baseQuery(over: Partial<FreeSlotQuery> = {}): FreeSlotQuery {
  return {
    timezone: TZ,
    from: '2026-03-09T00:00:00Z',
    to: '2026-03-10T00:00:00Z',
    durationMinutes: 30,
    now: '2026-03-01T00:00:00Z',
    availability: [{ day_of_week: 1, start_time: '08:00', end_time: '12:00' }], // Mon 08–12 local
    ...over,
  }
}

describe('computeFreeSlots', () => {
  it('turns a 4h Monday block into 30-min slots at the right UTC instants', () => {
    const slots = computeFreeSlots(baseQuery())
    // 08:00 local = 14:00Z … last slot starts 11:30 local = 17:30Z
    expect(slots[0].start).toBe('2026-03-09T14:00:00.000Z')
    expect(slots.at(-1)!.start).toBe('2026-03-09T17:30:00.000Z')
    expect(slots).toHaveLength(8)
    expect(slots.every((s) => new Date(s.end).getTime() - new Date(s.start).getTime() === 30 * 60_000)).toBe(true)
  })

  it('subtracts a busy appointment', () => {
    const slots = computeFreeSlots(
      baseQuery({ busy: [{ start: '2026-03-09T14:30:00Z', end: '2026-03-09T15:30:00Z' }] }),
    )
    const starts = slots.map((s) => s.start)
    expect(starts).toContain('2026-03-09T14:00:00.000Z')
    expect(starts).not.toContain('2026-03-09T14:30:00.000Z')
    expect(starts).not.toContain('2026-03-09T15:00:00.000Z')
    expect(starts).toContain('2026-03-09T15:30:00.000Z')
  })

  it('subtracts a blocked time-off window and honours an extra-hours block', () => {
    const blocked = computeFreeSlots(
      baseQuery({ timeOff: [{ starts_at: '2026-03-09T14:00:00Z', ends_at: '2026-03-09T16:00:00Z', is_extra_hours: false }] }),
    )
    expect(blocked[0].start).toBe('2026-03-09T16:00:00.000Z') // 10:00 local

    const extra = computeFreeSlots(
      baseQuery({
        availability: [],
        timeOff: [{ starts_at: '2026-03-09T20:00:00Z', ends_at: '2026-03-09T21:00:00Z', is_extra_hours: true }],
      }),
    )
    expect(extra.map((s) => s.start)).toEqual([
      '2026-03-09T20:00:00.000Z',
      '2026-03-09T20:30:00.000Z',
    ])
  })

  it('does not offer a slot that cannot fit the full duration', () => {
    const slots = computeFreeSlots(baseQuery({ durationMinutes: 45, stepMinutes: 45 }))
    // 08:00→12:00 local = 240 min → 5 × 45-min slots, last starts 11:00 local
    expect(slots).toHaveLength(5)
    expect(slots.at(-1)!.start).toBe('2026-03-09T17:00:00.000Z')
  })

  it('drops slots that start before `now`', () => {
    const slots = computeFreeSlots(baseQuery({ now: '2026-03-09T15:15:00Z' }))
    expect(slots[0].start).toBe('2026-03-09T15:30:00.000Z')
  })

  it('ignores availability for other weekdays', () => {
    const slots = computeFreeSlots(baseQuery({ availability: [{ day_of_week: 3, start_time: '08:00', end_time: '12:00' }] }))
    expect(slots).toEqual([])
  })

  it('returns [] for a bad window or duration', () => {
    expect(computeFreeSlots(baseQuery({ to: '2026-03-08T00:00:00Z' }))).toEqual([])
    expect(computeFreeSlots(baseQuery({ durationMinutes: 0 }))).toEqual([])
  })

  it('caps an over-long window instead of spinning', () => {
    const slots = computeFreeSlots(
      baseQuery({ from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z', maxWindowDays: 7, now: '2026-01-01T00:00:00Z' }),
    )
    // only the Mondays inside the first 7 days -> 2026-01-05
    expect(new Set(slots.map((s) => s.start.slice(0, 10)))).toEqual(new Set(['2026-01-05']))
  })
})

describe('overlapsBusy', () => {
  const busy = [{ start: '2026-03-09T14:00:00Z', end: '2026-03-09T15:00:00Z' }]
  it('detects an overlap and clears a clean gap', () => {
    expect(overlapsBusy('2026-03-09T14:30:00Z', '2026-03-09T15:30:00Z', busy)).toBe(true)
    expect(overlapsBusy('2026-03-09T15:00:00Z', '2026-03-09T15:30:00Z', busy)).toBe(false) // touches, no overlap
    expect(overlapsBusy('2026-03-09T13:00:00Z', '2026-03-09T14:00:00Z', busy)).toBe(false)
  })
})
