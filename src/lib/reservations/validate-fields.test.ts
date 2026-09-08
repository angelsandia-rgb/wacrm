import { describe, expect, it } from 'vitest'
import { reservationFieldError } from './validate-fields'

describe('reservation fields', () => {
  it.each([
    { check_in: '2026-02-30' }, { guests: 0 }, { guests: 2.5 },
    { duration_minutes: 2147483648 }, { estimated_price: Infinity },
    { estimated_price: 10000000000 },
    { check_in: '2026-09-10', check_out: '2026-09-09' },
  ])('rejects invalid values %j', (input) => {
    expect(reservationFieldError(input)).not.toBeNull()
  })
  it('allows sparse updates and explicit clearing', () => {
    expect(reservationFieldError({ check_in: '2026-09-09', guests: null })).toBeNull()
  })
})
