import { describe, it, expect } from 'vitest'
import { isQuoteIntent, statesDate } from './hotel-media-intent'

describe('banner only when quoting (owner, 2026-10-09)', () => {
  it('real quoting messages', () => {
    for (const t of ['Quiero ver si tienen habitaciones?', 'gracias, quisiera informacion para hospedaje', 'El fin de semana tienen spa?', 'Perdone tendrá 1 habitación para el día de hoy', 'necesitamos 10 habitaciones'])
      expect(isQuoteIntent(t), t).toBe(true)
  })
  it('real messages that got a banner by mistake', () => {
    for (const t of [
      'Disculpe me indicaron que hay solicitud de dos masajes, yo soy la masajista',
      'Los masajes serian sábado por la tarde?',
      'Una cónsulta el número que usted necesita es para coordinar la actividad de la próxima semana?',
      'La habitación está para los recién casados  Sirin Gudiel',
      'Confirmado  mi habitación  de hoy?',
    ])
      expect(isQuoteIntent(t), t).toBe(false)
  })
  it('statesDate (the #252 dates guard)', () => {
    expect(statesDate('Le dejo solicitada su Suite Master Deluxe para 2 personas el 11/10/2026')).toBe(true)
    expect(statesDate('¿Para qué fechas la desea?')).toBe(false)
  })
})
