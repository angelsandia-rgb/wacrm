import { describe, it, expect } from 'vitest'
import { stripCatalogUrls } from './auto-reply'

describe('stripCatalogUrls', () => {
  it('removes a long /catalog/<uuid> link with the signed ?c= query', () => {
    const s =
      'Claro, aquí tienes nuestro catálogo completo: https://chatsandia.com/catalog/09cd99b6-db6e-4644-a76b-01b11f7364f7?c=33b50897-efdc-4fdc-8434-d401e77cc42f.4d88bda4caf9b08d04241a4d'
    expect(stripCatalogUrls(s)).toBe('Claro, aquí tienes nuestro catálogo completo')
  })

  it('removes a short /c/<slug> link too', () => {
    expect(
      stripCatalogUrls('Aquí está nuestro catálogo: https://chatsandia.com/c/demoacount?c=abc.def'),
    ).toBe('Aquí está nuestro catálogo')
  })

  it('leaves a message with no catalog URL untouched', () => {
    const s = 'Claro, con gusto te comparto el catálogo 😊'
    expect(stripCatalogUrls(s)).toBe(s)
  })

  it('does not touch a non-catalog URL', () => {
    const s = 'Escríbenos por WhatsApp: https://wa.me/50255555555'
    expect(stripCatalogUrls(s)).toBe(s)
  })

  it('collapses whitespace when the URL was mid-sentence', () => {
    expect(
      stripCatalogUrls('mira https://chatsandia.com/catalog/00000000-0000-0000-0000-000000000000 para ver todo'),
    ).toBe('mira para ver todo')
  })

  it('returns "" when the message was only the link (caller keeps the original)', () => {
    expect(stripCatalogUrls('https://chatsandia.com/c/demo?c=x.y')).toBe('')
  })
})
