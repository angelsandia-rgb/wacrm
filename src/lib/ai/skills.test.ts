import { describe, expect, it } from 'vitest'
import { applySkillGates, normalizeSkills, skillRulesSection } from './skills'
import type { GenerateResult } from './types'

const RESULT = {
  text: 'hola',
  handoff: true,
  markDealWon: true,
  moveToStageName: 'Calificado',
  sendCatalog: true,
  sendPhotoProductName: 'Silla',
  leadTemperature: 'hot',
  contactName: 'Ana',
  appointmentProposal: { start: 's', end: 'e', email: 'a@x.com' },
  quoteProposal: null,
} as unknown as GenerateResult

describe('AI skills', () => {
  it('normalizes: drops unknown keys and defaults, keeps handoff always on', () => {
    expect(
      normalizeSkills({
        nope: { enabled: false },
        send_catalog: { enabled: true, when: '' },
        mark_deal_won: { enabled: false },
        handoff: { enabled: false, when: ' pide un humano ' },
      }),
    ).toEqual({ mark_deal_won: { enabled: false }, handoff: { enabled: true, when: 'pide un humano' } })
    expect(normalizeSkills(null)).toEqual({})
    expect(normalizeSkills('x')).toEqual({})
  })

  it('an empty config leaves the result untouched', () => {
    expect(applySkillGates(RESULT, {})).toEqual(RESULT)
    expect(applySkillGates(RESULT, undefined)).toBe(RESULT)
  })

  it('strips only the disabled actions; handoff can never be stripped', () => {
    const gated = applySkillGates(RESULT, {
      mark_deal_won: { enabled: false },
      send_photo: { enabled: false },
      schedule_appointment: { enabled: false },
    })
    expect(gated.markDealWon).toBe(false)
    expect(gated.sendPhotoProductName).toBeNull()
    expect(gated.appointmentProposal).toBeNull()
    expect(gated.handoff).toBe(true)
    expect(gated.moveToStageName).toBe('Calificado')
    expect(gated.sendCatalog).toBe(true)
  })

  it('renders rules only when there are any', () => {
    expect(skillRulesSection({})).toBeNull()
    const section = skillRulesSection({ send_catalog: { enabled: false }, handoff: { when: 'pide descuento' } }) ?? ''
    expect(section).toContain('Enviar el catálogo: NO lo hagas nunca')
    expect(section).toContain('hazlo solo cuando pide descuento')
  })
})
