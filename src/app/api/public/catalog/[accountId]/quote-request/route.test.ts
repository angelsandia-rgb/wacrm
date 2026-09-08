import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ success: true }),
  rateLimitResponse: vi.fn(), RATE_LIMITS: { publicCatalogQuote: {} },
}))
const admin = vi.hoisted(() => vi.fn(() => { throw new Error('Invalid input reached database') }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: admin }))
import { POST } from './route'

describe('public quote request input', () => {
  it.each([{ name: {} }, { phone: [] }, { nit: 4 }, { email: false }, { conversation_id: 123 }])(
    'rejects malformed contact fields before database access: %j', async (patch) => {
      const response = await POST(new Request('https://example.test/api/public/catalog/hotel/quote-request', {
        method: 'POST', body: JSON.stringify({
          name: 'Guest', phone: '50255555555', items: [{ product_id: 'p1', quantity: 1 }], ...patch,
        }),
      }), { params: Promise.resolve({ accountId: 'hotel' }) })
      expect(response.status).toBe(400)
      expect(admin).not.toHaveBeenCalled()
    },
  )
  it('bounds the public cart before database access', async () => {
    const response = await POST(new Request('https://example.test/api/public/catalog/hotel/quote-request', {
      method: 'POST', body: JSON.stringify({
        name: 'Guest', phone: '50255555555', items: Array.from({ length: 101 }, () => ({ product_id: 'p1' })),
      }),
    }), { params: Promise.resolve({ accountId: 'hotel' }) })
    expect(response.status).toBe(400)
    expect(admin).not.toHaveBeenCalled()
  })
  it('bounds public text fields before database access', async () => {
    const response = await POST(new Request('https://example.test/api/public/catalog/hotel/quote-request', {
      method: 'POST', body: JSON.stringify({
        name: 'x'.repeat(201), phone: '50255555555', items: [{ product_id: 'p1', quantity: 1 }],
      }),
    }), { params: Promise.resolve({ accountId: 'hotel' }) })
    expect(response.status).toBe(400)
    expect(admin).not.toHaveBeenCalled()
  })
})
