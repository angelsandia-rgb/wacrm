import { describe, it, expect } from 'vitest'
import { providerHttpError } from './shared'
import { isRetryableAiError } from '../generate'

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

describe('providerHttpError', () => {
  it('OpenAI out of credits (429 insufficient_quota) is quota_exhausted, not retried', async () => {
    const err = await providerHttpError(
      'OpenAI',
      errResponse(429, {
        error: {
          message: 'You have no credits remaining. Add credits to continue using the API.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      }),
    )
    expect(err.code).toBe('quota_exhausted')
    expect(isRetryableAiError(err)).toBe(false)
  })

  it('Anthropic low credit balance (400) is quota_exhausted', async () => {
    const err = await providerHttpError(
      'Anthropic',
      errResponse(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' },
      }),
    )
    expect(err.code).toBe('quota_exhausted')
  })

  it('a plain 429 is still a retryable rate limit', async () => {
    const err = await providerHttpError('OpenAI', errResponse(429, { error: { message: 'Rate limit reached for requests' } }))
    expect(err.code).toBe('rate_limited')
    expect(isRetryableAiError(err)).toBe(true)
  })
})
