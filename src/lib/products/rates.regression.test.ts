import { describe, expect, it } from 'vitest'
import { isValidHotelDate, nightsBetween, parseRates, resolveNightlyRate, type ProductRate } from './rates'

describe('hotel pricing regressions', () => {
  it('does not select an arbitrary price or cheaper occupancy on overlapping tariffs', () => {
    const rates: ProductRate[] = [
      { day_of_week: 'wed', occupancy: 'couple', price: 500, date_from: '2026-09-01', date_to: '2026-09-30' },
      { day_of_week: 'wed', occupancy: 'couple', price: 700, date_from: '2026-09-08', date_to: '2026-09-15' },
      { day_of_week: 'wed', occupancy: 'standard', price: 300, date_from: null, date_to: null },
    ]
    expect(resolveNightlyRate(rates, '2026-09-09', 'couple')).toBeNull()
    expect(parseRates(rates).ok).toBe(false)
    expect(parseRates([
      { day_of_week: 'wed', occupancy: 'standard', price: 300 },
      { day_of_week: 'wed', occupancy: 'standard', price: 400 },
    ]).ok).toBe(false)
  })
  it('rejects impossible calendar dates and accepts leap days', () => {
    expect(isValidHotelDate('2026-02-29')).toBe(false)
    expect(isValidHotelDate('2026-04-31')).toBe(false)
    expect(isValidHotelDate('2028-02-29')).toBe(true)
    expect(nightsBetween('2026-02-30', '2026-03-04')).toEqual([])
    expect(parseRates([{ day_of_week: 'mon', price: 500, date_from: '2026-02-30', date_to: '2026-03-04' }]).ok).toBe(false)
  })
  it('never returns a truncated priceable stay', () => {
    expect(nightsBetween('2026-01-01', '2027-01-02')).toHaveLength(366)
    expect(nightsBetween('2026-01-01', '2027-01-03')).toEqual([])
  })
  it('treats zero and invalid rates as missing, consistently with the catalog', () => {
    for (const price of [0, -10, NaN, Infinity]) {
      const rates: ProductRate[] = [{ day_of_week: 'wed', occupancy: 'standard', price, date_from: null, date_to: null }]
      expect(resolveNightlyRate(rates, '2026-09-09', 'standard')).toBeNull()
    }
  })
})
