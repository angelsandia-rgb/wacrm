import { describe, it, expect } from 'vitest'
import {
  hhmmToMinutes,
  isHexColor,
  parseAvailabilityBlocks,
  parseTimeOff,
  parseDoctorInput,
  DAY_LABELS_ES,
} from './doctors'

describe('hhmmToMinutes / isHexColor', () => {
  it('parses HH:MM', () => {
    expect(hhmmToMinutes('08:00')).toBe(480)
    expect(hhmmToMinutes('23:59')).toBe(1439)
    expect(hhmmToMinutes('24:00')).toBeNull()
    expect(hhmmToMinutes('8:00')).toBeNull()
    expect(hhmmToMinutes('nope')).toBeNull()
  })
  it('validates hex colour', () => {
    expect(isHexColor('#3b82f6')).toBe(true)
    expect(isHexColor('#ABC')).toBe(false)
    expect(isHexColor('3b82f6')).toBe(false)
    expect(isHexColor(42)).toBe(false)
  })
})

describe('parseAvailabilityBlocks', () => {
  it('accepts a valid weekly grid, normalises and sorts', () => {
    const r = parseAvailabilityBlocks([
      { day_of_week: 3, start_time: '14:00:00', end_time: '17:00' },
      { day_of_week: 1, start_time: '08:00', end_time: '12:00' },
      { day_of_week: 1, start_time: '13:00', end_time: '17:00' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual([
        { day_of_week: 1, start_time: '08:00', end_time: '12:00' },
        { day_of_week: 1, start_time: '13:00', end_time: '17:00' },
        { day_of_week: 3, start_time: '14:00', end_time: '17:00' },
      ])
    }
  })

  it('rejects overlaps on the same day', () => {
    const r = parseAvailabilityBlocks([
      { day_of_week: 2, start_time: '08:00', end_time: '13:00' },
      { day_of_week: 2, start_time: '12:00', end_time: '17:00' },
    ])
    expect(r).toEqual({ ok: false, error: expect.stringContaining('solapan') })
  })

  it('rejects end <= start, bad day, bad time, non-array', () => {
    expect(parseAvailabilityBlocks([{ day_of_week: 1, start_time: '12:00', end_time: '08:00' }]).ok).toBe(false)
    expect(parseAvailabilityBlocks([{ day_of_week: 7, start_time: '08:00', end_time: '12:00' }]).ok).toBe(false)
    expect(parseAvailabilityBlocks([{ day_of_week: 1, start_time: '8', end_time: '12:00' }]).ok).toBe(false)
    expect(parseAvailabilityBlocks('x').ok).toBe(false)
  })

  it('accepts an empty grid (doctor with no set hours)', () => {
    expect(parseAvailabilityBlocks([])).toEqual({ ok: true, value: [] })
  })
})

describe('parseTimeOff', () => {
  it('accepts a valid range', () => {
    const r = parseTimeOff({
      starts_at: '2026-04-01T08:00:00Z',
      ends_at: '2026-04-05T17:00:00Z',
      reason: '  Vacaciones  ',
      is_extra_hours: true,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.reason).toBe('Vacaciones')
      expect(r.value.is_extra_hours).toBe(true)
      expect(r.value.starts_at).toBe('2026-04-01T08:00:00.000Z')
    }
  })
  it('rejects end <= start, > 1 year, or bad dates', () => {
    expect(parseTimeOff({ starts_at: '2026-04-05T00:00:00Z', ends_at: '2026-04-01T00:00:00Z' }).ok).toBe(false)
    expect(parseTimeOff({ starts_at: '2026-01-01T00:00:00Z', ends_at: '2027-06-01T00:00:00Z' }).ok).toBe(false)
    expect(parseTimeOff({ starts_at: 'nope', ends_at: 'nope' }).ok).toBe(false)
  })
})

describe('parseDoctorInput', () => {
  it('create: requires a 2–120 char name', () => {
    expect(parseDoctorInput({ display_name: 'A' }, false).ok).toBe(false)
    const r = parseDoctorInput({ display_name: '  Dra. Ana López  ', specialty: 'Pediatría' }, false)
    expect(r).toEqual({ ok: true, value: { display_name: 'Dra. Ana López', specialty: 'Pediatría' } })
  })
  it('patch: only supplied keys; validates colour + user_id', () => {
    expect(parseDoctorInput({ color: 'red' }, true).ok).toBe(false)
    expect(parseDoctorInput({ user_id: 'not-a-uuid' }, true).ok).toBe(false)
    const r = parseDoctorInput({ is_active: false, color: null }, true)
    expect(r).toEqual({ ok: true, value: { is_active: false, color: null } })
  })
})

describe('DAY_LABELS_ES', () => {
  it('is Mon-first and covers 0..6', () => {
    expect(DAY_LABELS_ES.map((d) => d.value)).toEqual([1, 2, 3, 4, 5, 6, 0])
  })
})
