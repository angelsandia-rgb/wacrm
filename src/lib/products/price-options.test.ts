import { describe, it, expect } from 'vitest'
import {
  parsePriceOptions,
  parseInstallationCost,
  parseProductImages,
  MAX_PRICE_OPTIONS,
  MAX_PRODUCT_IMAGES,
} from './price-options'

describe('parsePriceOptions', () => {
  it('defaults to an empty list when the field is absent', () => {
    const result = parsePriceOptions(undefined)
    expect(result).toEqual({ ok: true, options: [] })
  })

  it('accepts a minimal option (label + price only)', () => {
    const result = parsePriceOptions([{ label: 'Talla XL', price: 150 }])
    expect(result).toEqual({
      ok: true,
      options: [{ label: 'Talla XL', price: 150, installation_cost: null, image_urls: [] }],
    })
  })

  it('accepts an option with installation cost and photos', () => {
    const result = parsePriceOptions([
      { label: 'Talla XL', price: 150, installation_cost: 25, image_urls: ['https://x/a.png', 'https://x/b.png'] },
    ])
    expect(result).toEqual({
      ok: true,
      options: [
        { label: 'Talla XL', price: 150, installation_cost: 25, image_urls: ['https://x/a.png', 'https://x/b.png'] },
      ],
    })
  })

  it('treats an empty-string installation_cost as absent', () => {
    const result = parsePriceOptions([{ label: 'A', price: 10, installation_cost: '' }])
    expect(result).toMatchObject({ ok: true, options: [{ installation_cost: null }] })
  })

  it('rejects more than MAX_PRICE_OPTIONS entries', () => {
    const raw = Array.from({ length: MAX_PRICE_OPTIONS + 1 }, (_, i) => ({ label: `Opt ${i}`, price: 1 }))
    const result = parsePriceOptions(raw)
    expect(result.ok).toBe(false)
  })

  it('rejects a missing label', () => {
    const result = parsePriceOptions([{ label: '  ', price: 10 }])
    expect(result.ok).toBe(false)
  })

  it('rejects a negative price', () => {
    const result = parsePriceOptions([{ label: 'A', price: -5 }])
    expect(result.ok).toBe(false)
  })

  it('rejects a negative installation_cost', () => {
    const result = parsePriceOptions([{ label: 'A', price: 10, installation_cost: -1 }])
    expect(result.ok).toBe(false)
  })

  it('rejects a non-array payload', () => {
    const result = parsePriceOptions({ label: 'A', price: 10 })
    expect(result.ok).toBe(false)
  })

  it('filters out non-string image_urls entries', () => {
    const result = parsePriceOptions([{ label: 'A', price: 10, image_urls: ['ok', 42, null, '  '] }])
    expect(result).toMatchObject({ ok: true, options: [{ image_urls: ['ok'] }] })
  })

  it('caps a price option at MAX_PRODUCT_IMAGES photos', () => {
    const many = Array.from({ length: 9 }, (_, i) => `https://x/${i}.png`)
    const result = parsePriceOptions([{ label: 'A', price: 10, image_urls: many }])
    expect(result.ok && result.options[0].image_urls).toHaveLength(MAX_PRODUCT_IMAGES)
  })
})

describe('parseProductImages', () => {
  it('keeps non-empty strings, trims, de-dupes, caps at 5', () => {
    expect(
      parseProductImages(['  a ', 'a', 'b', '', 42, 'c', 'd', 'e', 'f']),
    ).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('falls back to a bare image_url string when no array is given', () => {
    expect(parseProductImages(undefined, ' https://x/1.png ')).toEqual(['https://x/1.png'])
    expect(parseProductImages(undefined, '')).toEqual([])
    expect(parseProductImages(undefined, undefined)).toEqual([])
  })

  it('an array wins over the scalar fallback', () => {
    expect(parseProductImages(['a', 'b'], 'z')).toEqual(['a', 'b'])
  })
})

describe('parseInstallationCost', () => {
  it('treats undefined, null, and empty string as absent', () => {
    expect(parseInstallationCost(undefined)).toEqual({ ok: true, value: null })
    expect(parseInstallationCost(null)).toEqual({ ok: true, value: null })
    expect(parseInstallationCost('')).toEqual({ ok: true, value: null })
  })

  it('accepts a valid non-negative number (including 0)', () => {
    expect(parseInstallationCost(25)).toEqual({ ok: true, value: 25 })
    expect(parseInstallationCost(0)).toEqual({ ok: true, value: 0 })
    expect(parseInstallationCost('25.5')).toEqual({ ok: true, value: 25.5 })
  })

  it('rejects a negative number', () => {
    const result = parseInstallationCost(-1)
    expect(result.ok).toBe(false)
  })

  it('rejects a non-numeric value', () => {
    const result = parseInstallationCost('not a number')
    expect(result.ok).toBe(false)
  })
})
