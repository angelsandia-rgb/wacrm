import { describe, expect, it } from 'vitest'
import { yesterdayWindow } from './daily-summary'

describe('yesterdayWindow', () => {
  it('is the previous local day in Guatemala (UTC-6)', () => {
    // 00:15 local on Nov 2 = 06:15 UTC.
    expect(yesterdayWindow('America/Guatemala', new Date('2026-11-02T06:15:00Z'))).toEqual({
      date: '2026-11-01',
      start: '2026-11-01T06:00:00.000Z',
      end: '2026-11-02T06:00:00.000Z',
    })
  })
})
