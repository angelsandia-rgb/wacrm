import { describe, it, expect } from 'vitest'
import {
  buildSystemPrompt,
  RECORD_RESERVATION_SENTINEL_PREFIX,
  SEND_RESTAURANT_MENU_SENTINEL,
} from './defaults'

describe('buildSystemPrompt — hotel reservation marker gate', () => {
  it('teaches RECORD_RESERVATION only in auto_reply mode with hotelReservations on', () => {
    const on = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', hotelReservations: true })
    expect(on).toContain(RECORD_RESERVATION_SENTINEL_PREFIX)
    expect(on).toContain('habitaciones, spa, actividades, paquetes, eventos')
  })

  it('never mentions the marker when hotelReservations is off', () => {
    const off = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', hotelReservations: false })
    expect(off).not.toContain(RECORD_RESERVATION_SENTINEL_PREFIX)
  })

  it('never mentions the marker in draft mode even for a hotel', () => {
    const draft = buildSystemPrompt({ userPrompt: null, mode: 'draft', hotelReservations: true })
    expect(draft).not.toContain(RECORD_RESERVATION_SENTINEL_PREFIX)
  })
})

describe('buildSystemPrompt — current-date grounding', () => {
  it('embeds the given date and the "resolve relative dates yourself" rule, in both modes', () => {
    const now = 'jueves, 10 de septiembre de 2026, 20:30 (America/Guatemala)'
    for (const mode of ['auto_reply', 'draft'] as const) {
      const p = buildSystemPrompt({ userPrompt: null, mode, currentDate: now })
      expect(p).toContain(now)
      expect(p).toContain('el viernes')
      expect(p.toLowerCase()).toContain('do not ask the customer for the month or the year')
    }
  })

  it('says nothing about dates when currentDate is omitted', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(p).not.toContain("business's own timezone")
  })
})

describe('buildSystemPrompt — restaurant menu marker gate', () => {
  it('teaches SEND_RESTAURANT_MENU only in auto_reply mode with restaurantMenu on', () => {
    const on = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', restaurantMenu: true })
    expect(on).toContain(SEND_RESTAURANT_MENU_SENTINEL)
  })

  it('never mentions the marker when restaurantMenu is off', () => {
    const off = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', restaurantMenu: false })
    expect(off).not.toContain(SEND_RESTAURANT_MENU_SENTINEL)
  })

  it('never mentions the marker in draft mode', () => {
    const draft = buildSystemPrompt({ userPrompt: null, mode: 'draft', restaurantMenu: true })
    expect(draft).not.toContain(SEND_RESTAURANT_MENU_SENTINEL)
  })
})
