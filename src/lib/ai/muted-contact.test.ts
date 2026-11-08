import { describe, it, expect } from 'vitest'
import { isAiMuteTag } from './muted-contact'
import { isSpecialRateTalk } from './hotel-media-intent'
import { claimsOrderRegistration, customerRequestedCatalog } from './auto-reply'

describe('VSR review 2026-10-09', () => {
  it('mute tags, accent/case-insensitive', () => {
    for (const t of ['Interno', 'PERSONAL', 'Proveedor', 'Sin IA', ' sin ía ']) expect(isAiMuteTag(t), t).toBe(true)
    for (const t of ['VIP', 'Cliente', '', null]) expect(isAiMuteTag(t), String(t)).toBe(false)
  })
  it('special rates from real messages', () => {
    for (const t of ['Tengo un cupón con ustedes un voucher!', 'Es el paquete de tour operador de siempre', 'La tarifa que siempre e manejado con ustedes', 'Será la tarifa corporativa de suite Clasica'])
      expect(isSpecialRateTalk([t]), t).toBe(true)
    expect(isSpecialRateTalk(['Quisiera reservar para el sábado', 'cuánto cuesta la suite?'])).toBe(false)
  })
  it('a supplier offering THEIR catalog is not asking for ours', () => {
    expect(customerRequestedCatalog([{ role: 'user', content: 'Nos encantaría hacerle llegar nuestro catálogo digital.' }])).toBe(false)
    expect(customerRequestedCatalog([{ role: 'user', content: '¿Me envía su catálogo?' }])).toBe(true)
  })
})

describe('catalog requests (Casa Ceiba 2026-11-07)', () => {
  it('a typo like "catalofo" still asks for the catalog', () => {
    expect(customerRequestedCatalog([{ role: 'user', content: 'Si porta, el catalofo' }])).toBe(true)
  })
  it('"Sí" to the bot offering the catalog counts as a request', () => {
    expect(customerRequestedCatalog([
      { role: 'assistant', content: 'Claro 😊 ¿Quiere que le comparta el catálogo completo por aquí?' },
      { role: 'user', content: 'Si' },
    ])).toBe(true)
  })
})

describe('catalog ask survives a failed turn (Casa Ceiba 2026-11-07)', () => {
  const offer = { role: 'assistant' as const, content: 'Claro 😊 ¿Quiere que le comparta el catálogo completo por aquí?' }
  const fallback = { role: 'assistant' as const, content: 'Estoy teniendo una dificultad temporal para procesar su mensaje.' }
  it('"¿Ahora sí?" after the fallback still counts as the pending catalog ask', () => {
    expect(customerRequestedCatalog([offer, { role: 'user', content: 'Si' }, fallback, { role: 'user', content: 'Ahora si?' }])).toBe(true)
  })
  it('a catalog already sent ends the pending ask', () => {
    expect(customerRequestedCatalog([
      { role: 'user', content: '¿Me manda el catálogo?' },
      { role: 'assistant', content: 'Aquí está: https://chatsandia.com/c/casa-ceiba' },
      { role: 'user', content: '¿Cuánto cuesta la almohada?' },
    ])).toBe(false)
  })
})

describe('order claimed without the order marker (Casa Ceiba 2026-11-07)', () => {
  it('detects a "registering your order" claim', () => {
    expect(claimsOrderRegistration('Perfecto, lo estoy registrando 😊')).toBe(true)
    expect(claimsOrderRegistration('Estoy registrando su pedido.')).toBe(true)
    expect(claimsOrderRegistration('Su pedido quedó registrado.')).toBe(true)
  })
  it('ignores the summary and normal replies', () => {
    expect(claimsOrderRegistration('¿Me confirma para registrarlo?')).toBe(false)
    expect(claimsOrderRegistration('El masajeador cuesta GTQ 199.')).toBe(false)
  })
})
