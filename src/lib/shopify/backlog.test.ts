import { describe, expect, it } from 'vitest'
import { stuckByAccount } from './backlog'

const now = new Date('2026-11-15T12:00:00Z')
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString()

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
    expect(out.get('a')).toEqual({ requests: ['r-old'], jobs: [{ key: 'old', error: 'No approved template outside messaging window' }] })
    expect(out.get('b')).toEqual({ requests: [], jobs: [{ key: 'retried', error: 'boom' }] })
    // A deliberate wait is not stuck.
    expect(out.has('c')).toBe(false)
  })
})
