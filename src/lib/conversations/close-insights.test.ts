import { describe, expect, it } from 'vitest'
import { normalizeCloseConfig, parseCloseInsights } from './close-insights'

const CATS = ['Ventas', 'Soporte', 'Otros']

describe('parseCloseInsights', () => {
  it('reads the JSON even when wrapped in a code fence', () => {
    const r = parseCloseInsights(
      '```json\n{"category":"ventas","summary":"Pidió precio.","sentiment":"Positive","sentiment_reason":"Agradeció."}\n```',
      CATS,
    )
    expect(r).toEqual({ category: 'Ventas', summary: 'Pidió precio.', sentiment: 'positive', sentimentReason: 'Agradeció.' })
  })

  it('maps an unknown category to the last one', () => {
    expect(parseCloseInsights('{"category":"X","summary":"s","sentiment":"neutral"}', CATS)?.category).toBe('Otros')
  })

  it('rejects an empty summary, an unknown sentiment or broken JSON', () => {
    expect(parseCloseInsights('{"category":"Ventas","summary":"","sentiment":"neutral"}', CATS)).toBeNull()
    expect(parseCloseInsights('{"category":"Ventas","summary":"s","sentiment":"angry"}', CATS)).toBeNull()
    expect(parseCloseInsights('no json', CATS)).toBeNull()
    expect(parseCloseInsights('{bad', CATS)).toBeNull()
  })
})

describe('normalizeCloseConfig', () => {
  it('dedupes and trims categories and accepts an empty auto-close', () => {
    expect(
      normalizeCloseConfig({ insights_enabled: true, categories: [' Ventas ', 'Ventas', '', 'Pago'], auto_close_after_days: '' }),
    ).toEqual({ ok: true, value: { insights_enabled: true, categories: ['Ventas', 'Pago'], auto_close_after_days: null } })
  })

  it('rejects no categories and out-of-range days', () => {
    expect(normalizeCloseConfig({ categories: [] }).ok).toBe(false)
    expect(normalizeCloseConfig({ categories: ['a'], auto_close_after_days: 0 }).ok).toBe(false)
    expect(normalizeCloseConfig({ categories: ['a'], auto_close_after_days: 91 }).ok).toBe(false)
    expect(normalizeCloseConfig({ categories: ['a'], auto_close_after_days: 7 })).toMatchObject({
      ok: true,
      value: { auto_close_after_days: 7 },
    })
  })
})
