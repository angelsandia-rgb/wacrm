import { describe, it, expect } from 'vitest'
import { expandRecurrence } from './recurrence'

describe('expandRecurrence', () => {
  it('weekly: 4 sessions, 7 days apart, duration preserved', () => {
    const out = expandRecurrence('2026-03-09T15:00:00.000Z', 30, { frequency: 'weekly', count: 4 })
    expect(out.map((i) => i.start)).toEqual([
      '2026-03-09T15:00:00.000Z',
      '2026-03-16T15:00:00.000Z',
      '2026-03-23T15:00:00.000Z',
      '2026-03-30T15:00:00.000Z',
    ])
    expect(out[0].end).toBe('2026-03-09T15:30:00.000Z')
  })

  it('biweekly: 14 days apart', () => {
    const out = expandRecurrence('2026-03-09T15:00:00.000Z', 45, { frequency: 'biweekly', count: 3 })
    expect(out.map((i) => i.start)).toEqual([
      '2026-03-09T15:00:00.000Z',
      '2026-03-23T15:00:00.000Z',
      '2026-04-06T15:00:00.000Z',
    ])
  })

  it('monthly: same day-of-month, clamped to month length', () => {
    const out = expandRecurrence('2026-01-31T15:00:00.000Z', 30, { frequency: 'monthly', count: 4 })
    expect(out.map((i) => i.start)).toEqual([
      '2026-01-31T15:00:00.000Z',
      '2026-02-28T15:00:00.000Z', // clamped
      '2026-03-31T15:00:00.000Z',
      '2026-04-30T15:00:00.000Z', // clamped
    ])
  })

  it('rejects a bad spec', () => {
    expect(expandRecurrence('2026-03-09T15:00:00Z', 30, { frequency: 'weekly', count: 1 })).toEqual([])
    expect(expandRecurrence('2026-03-09T15:00:00Z', 30, { frequency: 'weekly', count: 99 })).toEqual([])
    expect(expandRecurrence('nope', 30, { frequency: 'weekly', count: 4 })).toEqual([])
    expect(expandRecurrence('2026-03-09T15:00:00Z', 0, { frequency: 'weekly', count: 4 })).toEqual([])
  })
})
