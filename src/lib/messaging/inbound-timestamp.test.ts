import { describe, expect, it } from 'vitest'
import { inboundCreatedAt } from './inbound-timestamp'

const NOW = new Date('2026-09-24T09:23:55.000Z')

describe('inboundCreatedAt', () => {
  it('uses the first plausible provider time', () => {
    expect(inboundCreatedAt([undefined, '2026-09-24T09:23:50.120Z'], NOW)).toBe('2026-09-24T09:23:50.120Z')
    expect(inboundCreatedAt([1790241830], NOW)).toBe('2026-09-24T09:23:50.000Z') // epoch seconds
    expect(inboundCreatedAt(['1790241830500'], NOW)).toBe('2026-09-24T09:23:50.500Z') // epoch ms
  })
  it('keeps a burst in the order the provider saw it', () => {
    const a = inboundCreatedAt(['2026-09-24T09:23:51.000Z'], NOW)!
    const b = inboundCreatedAt(['2026-09-24T09:23:52.000Z'], NOW)!
    expect(a < b).toBe(true)
  })
  it('ignores garbage and times far from now', () => {
    expect(inboundCreatedAt(['nope', null, {}], NOW)).toBeUndefined()
    expect(inboundCreatedAt(['2026-09-20T00:00:00Z'], NOW)).toBeUndefined()
  })
})
