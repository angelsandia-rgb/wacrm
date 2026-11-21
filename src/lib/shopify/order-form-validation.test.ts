import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseOrderForm } from './order-requests'

// The public form's field rules (public/shopify-order-form.js) run in the
// browser; they must accept what the server accepts and say why otherwise.
const src = readFileSync('public/shopify-order-form.js', 'utf8')
const block = src.slice(src.indexOf('var RULES = {'), src.indexOf('    function check('))
const RULES = new Function(`${block}; return RULES`)() as Record<string, (v: string) => string>

describe('order form field rules', () => {
  it.each(['4288 3689', '+502 4288-3689', '50242883689', '42883689'])('accepts the phone %s, as the server does', (phone) => {
    expect(RULES.phone(phone)).toBe('')
    expect(parseOrderForm({
      items: [{ variantId: '7', quantity: 1 }], fullName: 'Ana López', phone, address: '4a calle 8-20', municipio: 'Mixco', departamento: 'Guatemala',
    })).not.toHaveProperty('error')
  })
  it('explains each problem next to its field', () => {
    expect(RULES.phone('1234')).toContain('8 dígitos')
    expect(RULES.quantity('1.5')).toContain('entera')
    expect(RULES.quantity('21')).toContain('1 a 20')
    expect(RULES.fullName('Ana')).toContain('apellido')
    expect(RULES.address('x')).toContain('dirección')
    expect(RULES.municipio('')).toContain('municipio')
  })
})
