import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ tags: vi.fn(), saved: [] as Record<string, unknown>[], failSave: false }))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  loadShopifyConfig: async () => ({}), updateOrderTags: m.tags,
}))
import { resolveOrderConfirmation } from './order-confirmation'

const db = {
  from() {
    const c = {
      update: (value: Record<string, unknown>) => { m.saved.push(value); return c },
      eq: () => c, select: () => c, in: () => c,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: m.failSave ? { message: 'database unavailable' } : null }),
    }
    return c
  },
}
beforeEach(() => { m.saved = []; m.failSave = false; m.tags.mockReset() })
describe('persisting customer order decisions', () => {
  const pending = { dealId: 'd', orderId: 'o', orderName: '#1005', pipelineId: 'p' }
  it('records a cancellation locally even when Shopify tags cannot be updated', async () => {
    m.tags.mockRejectedValueOnce(new Error('Shopify unavailable'))
    const line = await resolveOrderConfirmation({ db: db as never, accountId: 'a', conversationId: 'c', pending, decision: 'cancel' })
    expect(m.saved).toContainEqual({ shopify_confirmation_decision: 'cancel' })
    expect(line).toContain('cancélelo en Dropi y en Shopify')
  })
  it('does not claim a decision succeeded if local persistence failed', async () => {
    m.failSave = true
    await expect(resolveOrderConfirmation({ db: db as never, accountId: 'a', conversationId: 'c', pending, decision: 'cancel' }))
      .rejects.toThrow('Cannot save order confirmation')
    expect(m.tags).not.toHaveBeenCalled()
  })
})
