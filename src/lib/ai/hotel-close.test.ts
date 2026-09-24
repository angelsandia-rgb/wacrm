import { describe, expect, it } from 'vitest'
import {
  closeLine,
  hasConflictingAmount,
  isPastDate,
  mentionedAmounts,
  stripTrailingPermissionQuestion,
} from './hotel-close'

describe('stripTrailingPermissionQuestion', () => {
  it('strips the permission questions seen in the 2026-09-24 test run', () => {
    expect(
      stripTrailingPermissionQuestion(
        'La Suite Clásica es muy cómoda. Para esas fechas, le queda del 13/10/2026 al 14/10/2026. ¿Desea que le deje registrada la solicitud para que el equipo le confirme disponibilidad y el total?',
      ),
    ).toBe('La Suite Clásica es muy cómoda. Para esas fechas, le queda del 13/10/2026 al 14/10/2026.')
    expect(stripTrailingPermissionQuestion('Total GTQ 1,160. ¿Le gustaría que la dejemos anotada para esas fechas?')).toBe(
      'Total GTQ 1,160.',
    )
    expect(stripTrailingPermissionQuestion('Así queda. ¿Desea que deje esta solicitud lista?')).toBe('Así queda.')
    expect(stripTrailingPermissionQuestion('¿Le gustaría que le deje anotada la solicitud para el 11/10/2026 por la mañana?')).toBe('')
  })

  it('leaves real questions and plain closes alone', () => {
    expect(stripTrailingPermissionQuestion('¿Para cuántas personas sería?')).toBeNull()
    expect(stripTrailingPermissionQuestion('¿Me confirma la fecha de salida?')).toBeNull()
    expect(stripTrailingPermissionQuestion('Queda anotado, en breve le escribimos.')).toBeNull()
    expect(stripTrailingPermissionQuestion('¿Cuál de estas le interesa?')).toBeNull()
  })
})

describe('mentionedAmounts / hasConflictingAmount', () => {
  it('parses quetzal amounts in the formats the bot writes', () => {
    expect(mentionedAmounts('el total estimado sería GTQ 1,160 y el anticipo Q580')).toEqual([1160, 580])
    expect(mentionedAmounts('Q.300 por persona, 50 minutos, 2 personas')).toEqual([300])
    expect(mentionedAmounts('sin precios aquí, 15:00 y 12:00')).toEqual([])
  })

  it('flags a model figure that contradicts the computed total (prueba #8: Q1,160 vs Q1,500)', () => {
    expect(hasConflictingAmount('el total estimado sería GTQ 1,160', 1500, 750)).toBe(true)
    expect(hasConflictingAmount('el total estimado sería GTQ 1,500 con anticipo de Q750', 1500, 750)).toBe(false)
    expect(hasConflictingAmount('queda anotado para el 07/11/2026', 1500, 750)).toBe(false)
  })
})

describe('isPastDate', () => {
  it('compares ISO dates as strings', () => {
    expect(isPastDate('2026-09-10', '2026-09-23')).toBe(true)
    expect(isPastDate('2026-09-23', '2026-09-23')).toBe(false)
    expect(isPastDate('2026-10-01', '2026-09-23')).toBe(false)
    expect(isPastDate(null, '2026-09-23')).toBe(false)
  })
})

describe('closeLine', () => {
  it('rotates warm variants that never ask a question', () => {
    const lines = [0, 1, 2, 3].map(closeLine)
    expect(new Set(lines).size).toBe(3)
    for (const l of lines) expect(l).not.toContain('?')
  })
})
