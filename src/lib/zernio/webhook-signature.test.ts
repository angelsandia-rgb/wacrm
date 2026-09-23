import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyZernioWebhookSignature } from './webhook-signature'

const sign = (body: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex')

describe('verifyZernioWebhookSignature', () => {
  const body = '{"event":"message.received"}'

  it('accepts a signature made with the configured secret', () => {
    expect(verifyZernioWebhookSignature(body, sign(body, 's3cret'), 's3cret')).toBe(true)
  })

  it('rejects a wrong or missing signature', () => {
    expect(verifyZernioWebhookSignature(body, sign(body, 'other'), 's3cret')).toBe(false)
    expect(verifyZernioWebhookSignature(body, null, 's3cret')).toBe(false)
    expect(verifyZernioWebhookSignature(body, 'short', 's3cret')).toBe(false)
  })

  it('fails closed on an empty secret, whose HMAC anyone could compute', () => {
    expect(verifyZernioWebhookSignature(body, sign(body, ''), '')).toBe(false)
  })
})
