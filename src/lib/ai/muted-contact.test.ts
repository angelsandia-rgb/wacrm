import { describe, it, expect } from 'vitest'
import { isAiMuteTag } from './muted-contact'
import { isSpecialRateTalk } from './hotel-media-intent'
import { customerRequestedCatalog } from './auto-reply'

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
