import { expect, it } from 'vitest'
import { hotelReceptionReason } from './hotel-assistance'

it('routes an existing group proposal without sending a new form', () => {
  expect(hotelReceptionReason([{ role: 'user', content: 'En seguimiento a lo conversado el día de ayer, podrían compartirme una propuesta para hospedar a 36 personas en habitaciones dobles y 2 habitaciones simples por favor.' }])).toContain('cotización en curso')
})
it('keeps ordinary new family lodging eligible', () => {
  expect(hotelReceptionReason([{ role: 'user', content: 'Queremos hospedarnos 7 personas en dos habitaciones del 5 al 6 de diciembre' }])).toBeNull()
})
