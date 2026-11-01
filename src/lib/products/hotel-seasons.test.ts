import { describe, expect, it } from 'vitest'
import { fullCalendarWeek, holyWeek, yearEndWeeks } from './hotel-seasons'
import { markPendingSeasonRates } from './rate-approval'
import { quoteStay, type ProductRate } from './rates'
describe('full hotel holiday weeks', () => {
 it('uses Monday through Easter Sunday in 2027', () => expect(holyWeek(2027)).toEqual({ from: '2027-03-22', to: '2027-03-28' }))
 it('includes both complete Christmas and New Year weeks', () => {
  expect(yearEndWeeks(2026)).toEqual({ from: '2026-12-21', to: '2027-01-03' })
  expect(yearEndWeeks(2027)).toEqual({ from: '2027-12-20', to: '2028-01-02' })
 })
 it('does not place a Sunday in the following week', () => expect(fullCalendarWeek('2026-12-27')).toEqual({ from: '2026-12-21', to: '2026-12-27' }))
 it('rejects invalid dates', () => expect(() => fullCalendarWeek('2027-02-30')).toThrow())
})
describe('unapproved seasonal prices', () => {
 const rates: ProductRate[] = [
  { day_of_week: 'sun', occupancy: 'couple', price: 600, date_from: null, date_to: null },
  { day_of_week: 'sun', occupancy: 'couple', price: 425, date_from: '2026-12-21', date_to: '2027-01-03' },
 ]
 it('blocks a disputed season without falling back to the ordinary rate', () => {
  const marked = markPendingSeasonRates(rates, 'Tarifas de temporada alta pendientes de confirmacion del hotel.')
  expect(quoteStay(marked, '2026-12-27', '2026-12-28', 'couple').missing).toEqual(['2026-12-27'])
  expect(quoteStay(marked, '2026-11-01', '2026-11-02', 'couple').total).toBe(600)
  expect(rates[1].requires_confirmation).toBeUndefined()
 })
 it('keeps an approved price unchanged', () => expect(quoteStay(markPendingSeasonRates(rates, 'Suite Premium'), '2026-12-27', '2026-12-28', 'couple').total).toBe(425))
})
