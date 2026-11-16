import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GT_MUNICIPIOS, checkMunicipio, departamentosOfMunicipio } from './gt-geo'

describe('Guatemala municipios — canonical list', () => {
  it('has the 22 departamentos and 340 municipios, none repeated inside a departamento', () => {
    expect(Object.keys(GT_MUNICIPIOS)).toHaveLength(22)
    expect(Object.values(GT_MUNICIPIOS).flat()).toHaveLength(340)
    for (const list of Object.values(GT_MUNICIPIOS)) expect(new Set(list).size).toBe(list.length)
  })

  it('the public order form offers exactly this list', () => {
    const script = readFileSync('public/shopify-order-form.js', 'utf8')
    const table = script.slice(script.indexOf('var MUNICIPIOS = {'), script.indexOf('var DEPARTAMENTOS'))
    const offered = Object.fromEntries([...table.matchAll(/^\s+'([^']+)': \[(.+)\],$/gm)]
      .map((m) => [m[1], m[2].split("', '").map((s) => s.replace(/'/g, ''))]))
    expect(offered).toEqual(GT_MUNICIPIOS)
  })

  it('normalises accents, case and spacing without guessing a place', () => {
    expect(checkMunicipio('  coban ', 'alta verapaz')).toEqual({ ok: true, municipio: 'Cobán', departamento: 'Alta Verapaz' })
    expect(checkMunicipio('SAN  JOSE PINULA', 'Guatemala')).toMatchObject({ ok: true, municipio: 'San José Pinula' })
    expect(checkMunicipio('Santa Cruz del Quiché', 'El Quiché')).toMatchObject({ ok: true, departamento: 'Quiché' })
    // How people write the capital; nothing beyond these aliases.
    expect(checkMunicipio('Ciudad de Guatemala', 'Guatemala')).toMatchObject({ ok: true, municipio: 'Guatemala' })
    expect(checkMunicipio('Petapa', 'Guatemala')).toMatchObject({ ok: true, municipio: 'San Miguel Petapa' })
  })

  it('refuses a place that does not exist, including a typo (the real #1004 case)', () => {
    expect(checkMunicipio('Guantemala', 'Guatemala')).toEqual({ ok: false, departamentos: [] })
    expect(checkMunicipio('62671 - Villa Canales (Santa Inés Petapa) | CAEX', 'Guatemala')).toEqual({ ok: false, departamentos: [] })
    expect(checkMunicipio('Zona 10', 'Guatemala')).toEqual({ ok: false, departamentos: [] })
    expect(checkMunicipio('Mixco', 'Narnia')).toEqual({ ok: false, departamentos: ['Guatemala'] })
  })

  it('refuses a municipio placed in the wrong departamento and says where it is', () => {
    expect(checkMunicipio('Villa Nueva', 'Escuintla')).toEqual({ ok: false, departamentos: ['Guatemala'] })
  })

  it('homonyms are valid only with their own departamento, never assumed', () => {
    expect(departamentosOfMunicipio('San Pedro Sacatepéquez')).toEqual(['Guatemala', 'San Marcos'])
    expect(checkMunicipio('San Pedro Sacatepéquez', 'San Marcos')).toMatchObject({ ok: true })
    expect(checkMunicipio('San Pedro Sacatepéquez', 'Guatemala')).toMatchObject({ ok: true })
    expect(checkMunicipio('San Pedro Sacatepéquez', 'Sacatepéquez')).toEqual({ ok: false, departamentos: ['Guatemala', 'San Marcos'] })
    expect(departamentosOfMunicipio('La Libertad').sort()).toEqual(['Huehuetenango', 'Petén'])
    expect(departamentosOfMunicipio('San José').sort()).toEqual(['Escuintla', 'Petén'])
  })
})
