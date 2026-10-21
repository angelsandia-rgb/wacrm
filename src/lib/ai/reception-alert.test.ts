import { describe, expect, it } from 'vitest'
import { hasNewReceptionRequest, latestCustomerTimestamp } from './reception-alert'

describe('new reception requests', () => {
  it('notifies a new customer message even when a different operation was already pending', () => {
    expect(hasNewReceptionRequest('2026-10-20T02:00:00Z', '2026-10-20T02:05:00Z')).toBe(true)
  })
  it.each([null, 'invalid', '2026-10-20T01:59:00Z', '2026-10-20T02:00:00Z'])('does not replay stale/unknown inbound %s', at => {
    expect(hasNewReceptionRequest('2026-10-20T02:00:00Z', at)).toBe(false)
  })
  it('uses the last customer turn, not an assistant timestamp or an older message', () => {
    expect(latestCustomerTimestamp([{ role: 'user', content: 'Pago', createdAt: '2026-10-20T02:01:00Z' }, { role: 'assistant', content: 'Hola', createdAt: '2026-10-20T02:02:00Z' }])).toBe('2026-10-20T02:01:00Z')
    expect(latestCustomerTimestamp([{ role: 'user', content: 'Hola' }])).toBeNull()
  })
})
