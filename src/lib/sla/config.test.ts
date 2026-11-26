import { describe, expect, it } from 'vitest'
import { normalizeSlaConfig, SLA_DEFAULTS } from './config'

describe('normalizeSlaConfig', () => {
  it('accepts the defaults (10 / 30 / 60, 8–20)', () => {
    expect(normalizeSlaConfig({ ...SLA_DEFAULTS, enabled: true })).toEqual({ ok: true, value: { ...SLA_DEFAULTS, enabled: true } })
  })
  it('stages must go in order', () => {
    expect(normalizeSlaConfig({ alert_minutes: 30, escalate_minutes: 10 }).ok).toBe(false)
    expect(normalizeSlaConfig({ alert_minutes: 10, escalate_minutes: 30, ai_ack_minutes: 20 }).ok).toBe(false)
  })
  it('an empty acknowledgement time turns the bot acknowledgement off', () => {
    const r = normalizeSlaConfig({ alert_minutes: 10, escalate_minutes: 30, ai_ack_minutes: '' })
    expect(r.ok && r.value.ai_ack_minutes).toBeNull()
  })
})
