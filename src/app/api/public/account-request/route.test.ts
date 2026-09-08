import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ success: true }),
  rateLimitResponse: vi.fn(), RATE_LIMITS: { accountRequest: {} },
}))
const sendEmail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/email/send', () => ({ sendEmail, EmailError: class EmailError extends Error {} }))
import { POST } from './route'

describe('public account request input', () => {
  it.each([{ company_name: {} }, { requester_name: [] }, { phone: 123 }, { email: false }])(
    'rejects malformed fields without sending email: %j', async (patch) => {
      const response = await POST(new Request('https://example.test/api/public/account-request', {
        method: 'POST', body: JSON.stringify({
          company_name: 'Hotel', requester_name: 'Ana', daily_inquiries: '30',
          phone: '50255555555', email: 'ana@example.com', ...patch,
        }),
      }))
      expect(response.status).toBe(400)
      expect(sendEmail).not.toHaveBeenCalled()
    },
  )
})
