import { describe, expect, it } from 'vitest'
import { isWithinTimeWindow, minutesInTimeZone } from './time-window'

// 2026-09-23 20:30 UTC = 14:30 in Guatemala (UTC-6, no DST).
const at = new Date('2026-09-23T20:30:00Z')

describe('minutesInTimeZone', () => {
  it('reads the wall clock in the given zone', () => {
    expect(minutesInTimeZone(at, 'America/Guatemala')).toBe(14 * 60 + 30)
    expect(minutesInTimeZone(at, 'UTC')).toBe(20 * 60 + 30)
  })

  it('falls back to UTC for a missing or invalid zone', () => {
    expect(minutesInTimeZone(at, null)).toBe(20 * 60 + 30)
    expect(minutesInTimeZone(at, 'Not/AZone')).toBe(20 * 60 + 30)
  })
})

describe('isWithinTimeWindow', () => {
  it('evaluates the out-of-office template in the account zone, not the server UTC clock', () => {
    // 14:30 local is business hours — 20:30 UTC would wrongly be "after 18:00".
    expect(isWithinTimeWindow('18:00-09:00', at, 'America/Guatemala')).toBe(false)
    expect(isWithinTimeWindow('18:00-09:00', at, 'UTC')).toBe(true)
  })

  it('handles same-day and over-midnight windows with an exclusive end', () => {
    const tz = 'America/Guatemala'
    expect(isWithinTimeWindow('09:00-18:00', at, tz)).toBe(true)
    expect(isWithinTimeWindow('09:00-14:30', at, tz)).toBe(false)
    expect(isWithinTimeWindow('22:00-06:00', new Date('2026-09-24T05:00:00Z'), tz)).toBe(true) // 23:00
    expect(isWithinTimeWindow('22:00-06:00', new Date('2026-09-24T13:00:00Z'), tz)).toBe(false) // 07:00
  })

  it('treats a malformed operand as outside', () => {
    expect(isWithinTimeWindow('', at, 'UTC')).toBe(false)
    expect(isWithinTimeWindow('18:00', at, 'UTC')).toBe(false)
    expect(isWithinTimeWindow(null, at, 'UTC')).toBe(false)
  })
})
