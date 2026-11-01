import { describe, expect, it } from 'vitest'
import { isHotelDaytimeBacklog, isOnlyAcknowledgement } from './hotel-opening-backlog'
const schedule = { timeZone: 'America/Guatemala', startHour: 20, endHour: 8 }
describe('hotel overnight opening backlog', () => {
  it('includes afternoon questions at 20:00 and throughout the same overnight shift', () => {
    expect(isHotelDaytimeBacklog(schedule, '2026-10-21T21:22:00Z', new Date('2026-10-22T02:00:00Z'))).toBe(true)
    expect(isHotelDaytimeBacklog(schedule, '2026-10-21T21:22:00Z', new Date('2026-10-22T12:00:00Z'))).toBe(true)
  })
  it('does not resume before 20:00, at 08:00, or from an older day', () => {
    expect(isHotelDaytimeBacklog(schedule, '2026-10-21T21:22:00Z', new Date('2026-10-22T01:59:59Z'))).toBe(false)
    expect(isHotelDaytimeBacklog(schedule, '2026-10-21T21:22:00Z', new Date('2026-10-22T14:00:00Z'))).toBe(false)
    expect(isHotelDaytimeBacklog(schedule, '2026-10-20T21:22:00Z', new Date('2026-10-22T02:00:00Z'))).toBe(false)
  })
  it('does not extend recovery for night messages or accounts without this schedule', () => {
    expect(isHotelDaytimeBacklog(schedule, '2026-10-21T03:00:00Z', new Date('2026-10-22T02:00:00Z'))).toBe(false)
    expect(isHotelDaytimeBacklog(null, '2026-10-21T21:22:00Z', new Date('2026-10-22T02:00:00Z'))).toBe(false)
  })
  it('avoids reopening a closed exchange just because the customer thanked the hotel', () => {
    expect(isOnlyAcknowledgement('Muy bien')).toBe(true)
    expect(isOnlyAcknowledgement('Gracias')).toBe(true)
    expect(isOnlyAcknowledgement('Gracias, ¿cuánto cuesta?')).toBe(false)
  })
})
