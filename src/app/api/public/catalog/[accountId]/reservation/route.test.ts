import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/rate-limit', () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ success: true }),
  rateLimitResponse: vi.fn(), RATE_LIMITS: { publicCatalogQuote: {} },
}))
const admin = vi.hoisted(() => vi.fn(() => { throw new Error('Invalid requests must not reach the DB') }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: admin }))
import { POST } from './route'

describe('public hotel reservation input', () => {
  it.each([
    { name: {} }, { phone: [] }, { conversation_id: 123 },
    { check_in: '2026-02-30' }, { check_in: '2026-05-02', check_out: '2026-05-01' },
    { check_in: 0 }, { use_date: false },
    { check_in: '2026-01-01', check_out: '2028-01-01' },
    { guests: 1.5 }, { guests: true }, { duration_minutes: 2147483648 },
  ])('returns 400 for malformed input %j', async (patch) => {
    const response = await POST(new Request('https://example.test/api/public/catalog/hotel/reservation', {
      method: 'POST', body: JSON.stringify({ name: 'Guest', phone: '50255555555', product_id: 'p1', ...patch }),
    }), { params: Promise.resolve({ accountId: 'hotel' }) })
    expect(response.status).toBe(400)
    expect(admin).not.toHaveBeenCalled()
  })
})
