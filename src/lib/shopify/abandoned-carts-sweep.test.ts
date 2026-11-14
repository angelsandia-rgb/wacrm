import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  enqueue: vi.fn(), deliver: vi.fn(), muted: false, legacy: null as { checkout_id: string; error: string | null } | null,
  legacyLookupFailed: false,
  graphql: vi.fn(),
}))
const cart = (id: string, updatedAt: string) => ({
  id, createdAt: updatedAt, updatedAt, completedAt: null,
  abandonedCheckoutUrl: 'https://shop/checkouts/recover', customer: null,
  shippingAddress: { firstName: 'Ana', phone: '54852732' },
  totalPriceSet: { shopMoney: { amount: '300.00', currencyCode: 'GTQ' } },
  lineItems: { nodes: [{ title: 'Producto', quantity: 1 }] },
})
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  loadShopifyConfig: async () => ({}),
  shopifyGraphql: (_cfg: unknown, _q: string, vars?: { after?: string | null }) => m.graphql(vars?.after ?? null),
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
  m.graphql.mockReset().mockResolvedValue({ abandonedCheckouts: { nodes: [cart('cart1', '2026-11-13T16:00:00Z')] } })
})

describe('abandoned cart pagination', () => {
  it('reaches an eligible cart behind more than one page of newer carts', async () => {
    const fresh = Array.from({ length: 50 }, (_, i) => cart(`new${i}`, '2026-11-13T17:50:00Z'))
    m.graphql
      .mockResolvedValueOnce({ abandonedCheckouts: { nodes: fresh, pageInfo: { hasNextPage: true, endCursor: 'p2' } } })
      .mockResolvedValueOnce({ abandonedCheckouts: { nodes: [cart('old', '2026-11-13T15:00:00Z')], pageInfo: { hasNextPage: false, endCursor: null } } })
    await runAbandonedCartSweep(db as never, now)
    expect(m.graphql).toHaveBeenNthCalledWith(2, 'p2')
    expect(m.enqueue).toHaveBeenCalledWith(expect.anything(), 'a', 'old:cart', expect.anything())
  })
  it('stops paging once it reaches carts older than the reminder window', async () => {
    m.graphql.mockResolvedValueOnce({ abandonedCheckouts: { nodes: [cart('stale', '2026-11-10T15:00:00Z')], pageInfo: { hasNextPage: true, endCursor: 'p2' } } })
    await runAbandonedCartSweep(db as never, now)
    expect(m.graphql).toHaveBeenCalledTimes(1)
  })
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
