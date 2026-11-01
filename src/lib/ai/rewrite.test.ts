import { describe, expect, it } from 'vitest'
import { buildRewritePrompt, cleanRewrite, isRewriteAction } from './rewrite'

describe('rewrite helpers', () => {
  it('accepts only known actions', () => {
    expect(isRewriteAction('fix')).toBe(true)
    expect(isRewriteAction('translate_en')).toBe(true)
    expect(isRewriteAction('delete_everything')).toBe(false)
    expect(isRewriteAction(undefined)).toBe(false)
  })

  it('builds a prompt that names the action and asks for the bare message', () => {
    const p = buildRewritePrompt('translate_en')
    expect(p).toContain('inglés')
    expect(p).toContain('SOLO con el mensaje final')
  })

  it('strips wrapping quotes and a leading label', () => {
    expect(cleanRewrite('"Hola, ¿cómo está?"')).toBe('Hola, ¿cómo está?')
    expect(cleanRewrite('Mensaje final: Hola')).toBe('Hola')
    expect(cleanRewrite('  Hola  ')).toBe('Hola')
  })
})
