import { isValidHotelDate, nightsBetween } from '@/lib/products/rates'

/** Sparse updates may omit dates. Validate a complete range whenever supplied. */
export function reservationFieldError(input: object): string | null {
  const values = input as Record<string, unknown>
  for (const key of ['check_in', 'check_out', 'use_date']) {
    if (values[key] != null && !isValidHotelDate(values[key])) return 'Invalid reservation date'
  }
  if (typeof values.check_in === 'string' && typeof values.check_out === 'string' &&
      !nightsBetween(values.check_in, values.check_out).length) return 'Stay must be 1 to 366 nights'
  for (const key of ['guests', 'duration_minutes']) {
    const value = values[key]
    if (value != null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647)) {
      return 'Invalid reservation quantity'
    }
  }
  const price = values.estimated_price
  if (price != null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 9999999999.99)) {
    return 'Invalid reservation price'
  }
  return null
}
