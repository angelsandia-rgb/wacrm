import { describe, expect, it } from 'vitest'
import {
  claimsRequestNoted,
  closeLine,
  isStillAsking,
  stripTrailingAttachmentOffer,
  hasConflictingAmount,
  isPastDate,
  mentionedAmounts,
  stripTrailingPermissionQuestion,
} from './hotel-close'

describe('stripTrailingPermissionQuestion', () => {
  it('strips a "quedo atenta para registrar" wait, even stacked with a permission question (B51)', () => {
    expect(
      stripTrailingPermissionQuestion('Paquete San Ricardo del 23/10 al 24/10, Gabriela. Quedo atenta para registrar las fechas.'),
    ).toBe('Paquete San Ricardo del 23/10 al 24/10, Gabriela.')
    expect(
      stripTrailingPermissionQuestion('Todo listo, Gabriela. Quedo atenta para registrarla. ¿Desea que se la deje lista?'),
    ).toBe('Todo listo, Gabriela.')
    expect(stripTrailingPermissionQuestion('Quedo atenta a cualquier duda. 😊')).toBeNull()
  })

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
    expect(stripTrailingPermissionQuestion('Se lo dejo anotado. ¿Desea que también le conecte con alguien del equipo?')).toBe('Se lo dejo anotado.')
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

describe('statement-form offers, imperative asks and attachment offers (re-tests 2026-09-24)', () => {
  it('strips a trailing "Si desea, le dejo la solicitud lista…" offer', () => {
    expect(
      stripTrailingPermissionQuestion(
        'El sábado aplica la tarifa recreativa. Si desea, le dejo la solicitud lista para que el equipo le confirme disponibilidad y el total.',
      ),
    ).toBe('El sábado aplica la tarifa recreativa.')
    expect(stripTrailingPermissionQuestion('Queda anotado para el 20/10. Nuestro equipo le escribirá.')).toBeNull()
  })

  it('treats an imperative request as still asking (prueba #36)', () => {
    expect(isStillAsking('Para dejarla bien registrada, por favor compárteme el nombre de la empresa y el NIT.')).toBe(true)
    expect(isStillAsking('Indíqueme la fecha, por favor.')).toBe(true)
    expect(isStillAsking('¿Para cuántas personas?')).toBe(true)
    expect(isStillAsking('Queda registrada su solicitud; en breve le escribimos.')).toBe(false)
  })

  it('drops "si gusta, le comparto el menú" when the menu is being sent (pruebas #3/#44)', () => {
    expect(
      stripTrailingAttachmentOffer('El almuerzo es de 12:00 a 17:00. Si gusta, también le comparto el menú completo.'),
    ).toBe('El almuerzo es de 12:00 a 17:00.')
    expect(stripTrailingAttachmentOffer('El almuerzo es de 12:00 a 17:00.')).toBeNull()
  })
})

describe('claimsRequestNoted', () => {
  it('detects a "saved" claim', () => {
    for (const m of ['Queda anotada la Suite Clásica Doble para 3 personas.', 'Perfecto, le registro 2 personas.', 'Ya quedó registrada su solicitud.', 'Quedan anotados sus datos.', 'Se la dejo anotada.']) {
      expect(claimsRequestNoted(m), m).toBe(true)
    }
  })
  it('ignores replies that save nothing', () => {
    for (const m of ['¿Para qué fechas la desea?', 'La Suite Premium tiene 2 camas Queen.', 'El registro de entrada es a las 15:00.']) {
      expect(claimsRequestNoted(m), m).toBe(false)
    }
  })
})
