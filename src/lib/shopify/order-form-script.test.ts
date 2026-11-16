import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { departamentoCode, municipioMatchesDepartamento } from './api'

// The public form's municipio table lives in a plain script the theme loads;
// the server only knows the departamentos, so the two must stay in step.
const script = readFileSync('public/shopify-order-form.js', 'utf8')
const table = script.slice(script.indexOf('var MUNICIPIOS = {'), script.indexOf('var DEPARTAMENTOS'))
const rows = [...table.matchAll(/^\s+'([^']+)': \[(.+)\],$/gm)].map((m) => ({
  departamento: m[1], municipios: m[2].split("', '").map((s) => s.replace(/'/g, '')),
}))

describe('order form municipio table', () => {
  it('lists the 22 departamentos and 340 municipios, without repeats', () => {
    expect(rows).toHaveLength(22)
    expect(rows.flatMap((r) => r.municipios)).toHaveLength(340)
    for (const r of rows) expect(new Set(r.municipios).size).toBe(r.municipios.length)
  })

  it('offers only choices the server accepts', () => {
    for (const r of rows) {
      expect(departamentoCode(r.departamento), r.departamento).toBeTruthy()
      for (const m of r.municipios) expect(municipioMatchesDepartamento(m, r.departamento), `${m}, ${r.departamento}`).toBe(true)
    }
  })
})
