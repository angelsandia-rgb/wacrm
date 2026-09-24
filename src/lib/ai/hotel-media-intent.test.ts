import { describe, expect, it } from 'vitest'
import { isPhotoPromise, productAskedAbout } from './hotel-media-intent'
import { categorySlugsMentioned } from '@/lib/reservations/upsert'

const HOTEL = [
  'Suite Clásica (Individual o Pareja)',
  'Suite Premium',
  'Suite Master Deluxe',
  'Paquete Romántico',
  'Paquete Luna de Miel',
  'Masaje Relajante',
  'Masaje Deep Tissue',
]

describe('productAskedAbout', () => {
  it('finds the item from a distinctive word (the 2026-09-24 conversation)', () => {
    expect(productAskedAbout('tiene fotos de la habitación deluxe?', HOTEL)).toBe('Suite Master Deluxe')
    expect(productAskedAbout('me interesa el paquete romantico', HOTEL)).toBe('Paquete Romántico')
    expect(productAskedAbout('¿cuánto cuesta la luna de miel?', HOTEL)).toBe('Paquete Luna de Miel')
  })

  it('matches a full name, accents and parenthesized notes ignored', () => {
    expect(productAskedAbout('Quiero la suite clasica para 2', HOTEL)).toBe('Suite Clásica (Individual o Pareja)')
    expect(productAskedAbout('info del Masaje Relajante', HOTEL)).toBe('Masaje Relajante')
  })

  it('stays silent on generic or ambiguous messages', () => {
    expect(productAskedAbout('las habitaciones cuanto cuestan?', HOTEL)).toBeNull()
    expect(productAskedAbout('qué suites tienen?', HOTEL)).toBeNull()
    expect(productAskedAbout('un masaje por favor', HOTEL)).toBeNull()
    expect(productAskedAbout('la premium o la deluxe?', HOTEL)).toBeNull()
    expect(productAskedAbout('hola', HOTEL)).toBeNull()
  })

  it('prefers the longest full-name match over one it contains', () => {
    const names = ['Suite Deluxe', 'Suite Master Deluxe']
    expect(productAskedAbout('fotos de la suite master deluxe', names)).toBe('Suite Master Deluxe')
    expect(productAskedAbout('fotos de la suite deluxe', names)).toBe('Suite Deluxe')
  })
})

describe('productAskedAbout on the real Villa San Ricardo catalog', () => {
  const VSR = [
    'Alquiler de bicicleta (30 min)', 'Alquiler de cuatrimoto (15 min)', 'Alquiler de cuatrimoto (30 min)',
    'Tour al Nacimiento', 'Junior Suite Familiar', 'Suite Clásica (Individual o Pareja)', 'Suite Clásica Doble',
    'Suite Master Deluxe', 'Suite Premium', 'Paquete Luna de Miel', 'Paquete Romántico', 'Paquete San Ricardo',
    'Paquete San Vicente', 'Masaje Deep Tissue', 'Masaje Drenaje Linfático', 'Masaje Express',
    'Masaje Reductor', 'Masaje Reflexología', 'Masaje Relajante', 'Masaje Shiatsu',
  ]
  const ask = (m: string) => productAskedAbout(m, VSR, 'Villa San Ricardo')

  it('never mistakes the hotel name for the San Ricardo package', () => {
    expect(ask('hola, es el hotel san ricardo?')).toBeNull()
    expect(ask('info de villa san ricardo')).toBeNull()
    expect(ask('quiero el paquete san ricardo')).toBe('Paquete San Ricardo')
  })

  it('resolves distinctive names and leaves shared ones ambiguous', () => {
    expect(ask('fotos de la junior')).toBe('Junior Suite Familiar')
    expect(ask('el shiatsu cuanto dura?')).toBe('Masaje Shiatsu')
    expect(ask('quiero bicicleta')).toBe('Alquiler de bicicleta (30 min)')
    expect(ask('la suite clasica')).toBeNull() // two Clásica suites
    expect(ask('las cuatrimotos')).toBeNull()
    expect(ask('tienen spa?')).toBeNull()
  })
})

describe('isPhotoPromise', () => {
  it('accepts an outright promise', () => {
    expect(isPhotoPromise('Con gusto, le comparto la foto de la Suite Premium.')).toBe(true)
    expect(isPhotoPromise('Aquí tiene la imagen de la suite')).toBe(true)
  })

  it('rejects conditional offers and questions', () => {
    expect(isPhotoPromise('¿Se refiere a la Suite Master Deluxe? Si me confirma, le envío la foto de esa habitación.')).toBe(false)
    expect(isPhotoPromise('¿Le envío la foto?')).toBe(false)
    expect(isPhotoPromise('Si gusta, le comparto la foto.')).toBe(false)
    expect(isPhotoPromise('Cuando me confirme la habitación, le envío la foto.')).toBe(false)
    expect(isPhotoPromise('Tenemos tres suites disponibles.')).toBe(false)
  })
})

describe('categorySlugsMentioned', () => {
  it('lists every category a message names', () => {
    expect(categorySlugsMentioned('las habitaciones cuanto cuestan?')).toEqual(['habitaciones'])
    expect(categorySlugsMentioned('¿qué tienen de spa?')).toEqual(['spa'])
    expect(categorySlugsMentioned('quiero una habitación y un masaje')).toEqual(['habitaciones', 'spa'])
    expect(categorySlugsMentioned('hola')).toEqual([])
  })
})
