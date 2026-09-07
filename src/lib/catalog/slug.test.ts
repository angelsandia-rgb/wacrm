import { describe, it, expect } from 'vitest'
import { slugifyCatalog, isValidCatalogSlug, looksLikeUuid } from './slug'

describe('slugifyCatalog', () => {
  it('lowercases, folds accents and hyphenates', () => {
    expect(slugifyCatalog('Hotel Sandía')).toBe('hotel-sandia')
    expect(slugifyCatalog('  ¡Mega Tienda!!  2026 ')).toBe('mega-tienda-2026')
    expect(slugifyCatalog('Café & Té')).toBe('cafe-te')
  })

  it('returns "" when nothing usable is left', () => {
    expect(slugifyCatalog('###')).toBe('')
    expect(slugifyCatalog('   ')).toBe('')
  })

  it('truncates to 40 chars without a trailing hyphen', () => {
    const out = slugifyCatalog('a'.repeat(30) + ' ' + 'b'.repeat(30))
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.endsWith('-')).toBe(false)
  })
})

describe('isValidCatalogSlug', () => {
  it('accepts lowercase hyphenated segments, 3–40 chars', () => {
    expect(isValidCatalogSlug('mi-empresa')).toBe(true)
    expect(isValidCatalogSlug('abc')).toBe(true)
    expect(isValidCatalogSlug('a1-b2-c3')).toBe(true)
  })
  it('rejects too short, edge/double hyphens, uppercase, spaces', () => {
    expect(isValidCatalogSlug('ab')).toBe(false)
    expect(isValidCatalogSlug('-abc')).toBe(false)
    expect(isValidCatalogSlug('abc-')).toBe(false)
    expect(isValidCatalogSlug('a--b')).toBe(false)
    expect(isValidCatalogSlug('ABC')).toBe(false)
    expect(isValidCatalogSlug('mi empresa')).toBe(false)
    expect(isValidCatalogSlug('x'.repeat(41))).toBe(false)
  })
})

describe('looksLikeUuid', () => {
  it('matches a v4-shaped uuid, nothing else', () => {
    expect(looksLikeUuid('09cd99b6-db6e-4644-a76b-01b11f7364f7')).toBe(true)
    expect(looksLikeUuid('mi-empresa')).toBe(false)
    expect(looksLikeUuid('09cd99b6db6e4644a76b01b11f7364f7')).toBe(false)
  })
})
