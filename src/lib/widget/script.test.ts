import { describe, expect, it } from 'vitest'
import { widgetScript } from './script'

describe('widgetScript', () => {
  it('embeds the number as a JS string literal and parses', () => {
    const src = widgetScript('50212345678')
    expect(src).toContain('"50212345678"')
    expect(() => new Function(src)).not.toThrow()
  })
})
