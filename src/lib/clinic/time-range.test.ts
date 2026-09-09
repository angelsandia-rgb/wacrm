import { describe, it, expect } from 'vitest'
import { rangeBounds, localMidnightUTC, isAppointmentRange } from './time-range'

// America/Guatemala = UTC-6, no DST. Local midnight = 06:00Z.
const TZ = 'America/Guatemala'
const NOW = new Date('2026-03-11T20:00:00Z') // Wed 2026-03-11 14:00 local

describe('localMidnightUTC', () => {
  it('resolves a Guatemala local midnight to 06:00Z', () => {
    expect(localMidnightUTC(2026, 3, 11, TZ).toISOString()).toBe('2026-03-11T06:00:00.000Z')
  })
})

describe('rangeBounds', () => {
  it('today / tomorrow', () => {
    expect(rangeBounds('today', TZ, NOW)).toEqual({
      from: '2026-03-11T06:00:00.000Z',
      to: '2026-03-12T06:00:00.000Z',
    })
    expect(rangeBounds('tomorrow', TZ, NOW)).toEqual({
      from: '2026-03-12T06:00:00.000Z',
      to: '2026-03-13T06:00:00.000Z',
    })
  })

  it('week is Monday-based', () => {
    // 2026-03-11 is a Wednesday → week starts Mon 2026-03-09
    expect(rangeBounds('week', TZ, NOW)).toEqual({
      from: '2026-03-09T06:00:00.000Z',
      to: '2026-03-16T06:00:00.000Z',
    })
  })

  it('month spans the calendar month', () => {
    expect(rangeBounds('month', TZ, NOW)).toEqual({
      from: '2026-03-01T06:00:00.000Z',
      to: '2026-04-01T06:00:00.000Z',
    })
  })

  it('all is a wide window around today', () => {
    const r = rangeBounds('all', TZ, NOW)
    expect(new Date(r.from).getTime()).toBeLessThan(NOW.getTime())
    expect(new Date(r.to).getTime()).toBeGreaterThan(NOW.getTime())
  })
})

describe('isAppointmentRange', () => {
  it('narrows', () => {
    expect(isAppointmentRange('week')).toBe(true)
    expect(isAppointmentRange('year')).toBe(false)
  })
})
