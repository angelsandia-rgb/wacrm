import { describe, it, expect } from 'vitest'
import { stripCatalogUrls, canonicalizeCatalogUrls, hasCatalogUrl } from './auto-reply'

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

describe('hasCatalogUrl', () => {
  it('is true for both link shapes and false otherwise', () => {
    expect(hasCatalogUrl('mira https://chatsandia.com/c/demo?c=x.y')).toBe(true)
    expect(
      hasCatalogUrl('https://chatsandia.com/catalog/09cd99b6-db6e-4644-a76b-01b11f7364f7'),
    ).toBe(true)
    expect(hasCatalogUrl('sin enlace, gracias 😊')).toBe(false)
    expect(hasCatalogUrl('Escríbenos: https://wa.me/50255555555')).toBe(false)
  })
})

describe('canonicalizeCatalogUrls', () => {
  const LIVE = 'https://chatsandia.com/c/villa-san-ricardo?c=abc.def'

  it('rewrites a stale short /c/<old-slug> link to the live one', () => {
    expect(
      canonicalizeCatalogUrls(
        'Puedes ver nuestro catálogo completo aquí: https://chatsandia.com/c/demo?c=abc.def',
        LIVE,
      ),
    ).toBe(`Puedes ver nuestro catálogo completo aquí: ${LIVE}`)
  })

  it('rewrites a long /catalog/<uuid> link too', () => {
    expect(
      canonicalizeCatalogUrls(
        'mira https://chatsandia.com/catalog/09cd99b6-db6e-4644-a76b-01b11f7364f7?c=abc.def para ver todo',
        LIVE,
      ),
    ).toBe(`mira ${LIVE} para ver todo`)
  })

  it('collapses a reply that pasted two catalog links into one live link', () => {
    const s =
      'Aquí tienes el catálogo: https://chatsandia.com/catalog/09cd99b6-db6e-4644-a76b-01b11f7364f7?c=abc.def\n' +
      'Puedes verlo aquí: https://chatsandia.com/c/demo?c=abc.def'
    const out = canonicalizeCatalogUrls(s, LIVE)
    expect(out).toContain(LIVE)
    expect(out.match(/https?:\/\//g) ?? []).toHaveLength(1)
    expect(out).not.toContain('/c/demo')
  })

  it('leaves a message with no catalog URL exactly as-is', () => {
    const s = 'Claro, con gusto te ayudo con eso -'
    expect(canonicalizeCatalogUrls(s, LIVE)).toBe(s)
  })

  it('does not touch a non-catalog URL', () => {
    const s = 'Escríbenos por WhatsApp: https://wa.me/50255555555'
    expect(canonicalizeCatalogUrls(s, LIVE)).toBe(s)
  })
})
