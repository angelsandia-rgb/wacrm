import { describe, it, expect } from 'vitest'
import {
  buildSystemPrompt,
  RECORD_RESERVATION_SENTINEL_PREFIX,
  SEND_RESTAURANT_MENU_SENTINEL,
  SET_CONTACT_NAME_SENTINEL_PREFIX,
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

describe('buildSystemPrompt — set-contact-name marker gate', () => {
  it('teaches SET_CONTACT_NAME in auto_reply mode', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(p).toContain(SET_CONTACT_NAME_SENTINEL_PREFIX)
  })

  it('never mentions it in draft mode', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(p).not.toContain(SET_CONTACT_NAME_SENTINEL_PREFIX)
  })
})

describe('buildSystemPrompt — hotel stay estimate', () => {
  it('lets the bot share the computed figure and never appears in draft mode', () => {
    const est = 'Master Suite Deluxe · 1 noche: Total estimado: Q500.'
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', hotelStayEstimate: est })
    expect(p).toContain(est)
    expect(p.toLowerCase()).toContain('give them this exact number')
    expect(
      buildSystemPrompt({ userPrompt: null, mode: 'draft', hotelStayEstimate: est }),
    ).not.toContain(est)
  })
})

describe('buildSystemPrompt — flow handoff directive', () => {
  it('injects the directive as a priority task in auto_reply mode', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      flowDirective: 'Busca la opción elegida en la base de conocimientos.',
    })
    expect(p).toContain('Busca la opción elegida en la base de conocimientos.')
    expect(p.toLowerCase()).toContain('priority task')
  })

  it('is silent when no directive is passed, and never appears in draft mode', () => {
    expect(buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })).not.toContain('priority task')
    expect(
      buildSystemPrompt({ userPrompt: null, mode: 'draft', flowDirective: 'do X' }),
    ).not.toContain('do X')
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
