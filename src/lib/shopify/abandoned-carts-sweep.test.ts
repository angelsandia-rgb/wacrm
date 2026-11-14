import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  enqueue: vi.fn(), deliver: vi.fn(), muted: false, legacy: null as { checkout_id: string; error: string | null } | null,
  legacyLookupFailed: false,
}))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  loadShopifyConfig: async () => ({}),
  shopifyGraphql: async () => ({ abandonedCheckouts: { nodes: [{
    id: 'cart1', updatedAt: '2026-11-13T16:00:00Z', completedAt: null,
    abandonedCheckoutUrl: 'https://shop/checkouts/recover', customer: null,
    shippingAddress: { firstName: 'Ana', phone: '54852732' },
    totalPriceSet: { shopMoney: { amount: '300.00', currencyCode: 'GTQ' } },
    lineItems: { nodes: [{ title: 'Producto', quantity: 1 }] },
  }] } }),
}))
vi.mock('./notification-jobs', () => ({ enqueueOrderNotification: m.enqueue, runOrderNotificationSweep: m.deliver }))
vi.mock('@/lib/ai/muted-contact', () => ({ contactMutesAi: async () => m.muted }))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: async () => ({ contactId: 'ct', conversationId: 'conv' }) }))
import { runAbandonedCartSweep } from './abandoned-carts'

const filters: [string, unknown][] = []
const db = { from(table: string) {
  const c = {
    select: () => c,
    eq: (key: string, value: unknown) => { filters.push([key, value]); return c },
    maybeSingle: async () => ({ data: m.legacy, error: m.legacyLookupFailed ? { message: 'database unavailable' } : null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: table === 'shopify_config'
      ? [{ account_id: 'a', accounts: { name: 'Casa Ceiba', timezone: 'America/Guatemala' } }] : [], error: null }),
  }
  return c
} }
const now = new Date('2026-11-13T18:00:00Z')
beforeEach(() => {
  vi.clearAllMocks(); filters.length = 0
  m.legacy = null; m.muted = false; m.legacyLookupFailed = false
  m.deliver.mockResolvedValue({ sent: 0, pending: 1, skipped: 0 })
})

describe('migrating abandoned-cart attempts to durable delivery', () => {
  it('recovers a failed legacy attempt instead of skipping the checkout forever', async () => {
    m.legacy = { checkout_id: 'cart1', error: 'WhatsApp unavailable' }
    expect(await runAbandonedCartSweep(db as never, now)).toEqual({ sent: 0, pending: 1, failed: 0 })
    expect(m.enqueue).toHaveBeenCalledWith(db, 'a', 'cart1:cart', expect.objectContaining({
      cart: { checkoutId: 'cart1', contactId: 'ct', phone: '+50254852732', storeName: 'Casa Ceiba' },
      template: expect.objectContaining({ names: ['carrito_abandonado'] }),
    }))
    expect(filters).toContainEqual(['account_id', 'a'])
  })
  it('does not resend a successful legacy reminder', async () => {
    m.legacy = { checkout_id: 'cart1', error: null }
    expect(await runAbandonedCartSweep(db as never, now)).toEqual({ sent: 0, pending: 0, failed: 0 })
    expect(m.enqueue).not.toHaveBeenCalled()
  })
  it('does not treat a database lookup failure as a new cart', async () => {
    m.legacyLookupFailed = true
    expect((await runAbandonedCartSweep(db as never, now)).failed).toBe(1)
    expect(m.enqueue).not.toHaveBeenCalled()
  })
  it('respects a contact excluded from AI before scheduling a reminder', async () => {
    m.muted = true
    await runAbandonedCartSweep(db as never, now)
    expect(m.enqueue).not.toHaveBeenCalled()
  })
})
