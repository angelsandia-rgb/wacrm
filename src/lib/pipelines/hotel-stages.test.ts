import { describe, expect, it } from 'vitest'
import { hotelStageKind, reservationStageKind } from './hotel-stages'

describe('hotel opportunity state', () => {
  it('keeps guest confirmation pending hotel approval', () => {
    expect(reservationStageKind('pending', null)).toBe('quote')
    expect(reservationStageKind('pending', '2026-10-20T03:00:00Z')).toBe('pending')
    expect(reservationStageKind('approved', null)).toBe('confirmed')
    expect(reservationStageKind('denied', null)).toBe('discard')
  })
  it('recognizes only explicit discard and canonical hotel stages', () => {
    expect(hotelStageKind(' Descarte ')).toBe('discard')
    expect(hotelStageKind('Pendiente de confirmación')).toBe('pending')
    expect(hotelStageKind('Conversación')).toBeNull()
  })
})
