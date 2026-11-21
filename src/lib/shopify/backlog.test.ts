import { describe, expect, it } from 'vitest'
import { requestReminderText, stuckByAccount } from './backlog'

const now = new Date('2026-11-15T12:00:00Z')
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString()

describe('requestReminderText', () => {
  it('names the purchase and promises only what is true: nothing ships before the customer accepts', () => {
    const text = requestReminderText('Ana', '2 x Freidora de Aire', 'Q1,000')
    expect(text).toContain('Hola Ana, su pedido de 2 x Freidora de Aire por Q1,000')
    expect(text).toContain('no lo enviamos hasta que nos confirme')
    expect(requestReminderText('', '1 x Sofá', 'Q400').startsWith('Hola, su pedido')).toBe(true)
  })
})

describe('stuckByAccount', () => {
  it('flags requests stuck mid-placement and undelivered notices, per account', () => {
    const out = stuckByAccount(
      [
        { id: 'r-old', account_id: 'a', decided_at: ago(20) },
        { id: 'r-new', account_id: 'a', decided_at: ago(2) },
      ],
      [
        { account_id: 'a', event_key: 'old', attempts: 3, created_at: ago(180), last_error: 'No approved template outside messaging window' },
        { account_id: 'b', event_key: 'retried', attempts: 8, created_at: ago(30), last_error: 'boom' },
        { account_id: 'b', event_key: 'fresh', attempts: 1, created_at: ago(10), last_error: null },
        { account_id: 'c', event_key: 'night', attempts: 40, created_at: ago(600), last_error: 'Waiting for business hours' },
      ],
      now,
    )
    expect(out.get('a')).toEqual({ cases: [], requests: ['r-old'], jobs: [{ key: 'old', error: 'No approved template outside messaging window' }] })
    expect(out.get('b')).toEqual({ cases: [], requests: [], jobs: [{ key: 'retried', error: 'boom' }] })
    // A deliberate wait is not stuck.
    expect(out.has('c')).toBe(false)
  })
  it('escalates SAC cases open more than 24 h', () => {
    const out = stuckByAccount([], [], now, [
      { id: 'old', account_id: 'a', created_at: ago(25 * 60) },
      { id: 'new', account_id: 'a', created_at: ago(60) },
    ])
    expect(out.get('a')?.cases).toEqual(['old'])
  })
})
