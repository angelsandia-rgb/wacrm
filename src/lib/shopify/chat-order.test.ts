import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ stock: vi.fn(), create: vi.fn(), handoff: vi.fn(), send: vi.fn() }))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  loadShopifyConfig: async () => ({ shop: 'store', token: 't' }),
  outOfStockTitles: m.stock, createShopifyOrder: m.create,
}))
import { createShopifyOrderFromChat } from './chat-order'

const db = {
  from(table: string) {
    const c = {
      select: () => c, eq: () => c, contains: () => c, gte: () => c, limit: () => c, not: () => c,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: table === 'products'
        ? [{ name: 'Producto', price: 300, shopify_variant_id: 'gid://shopify/ProductVariant/1' }] : [] }),
    }
    return c
  },
}
beforeEach(() => { vi.clearAllMocks() })
describe('order inventory safety', () => {
  it.each(['cod', 'card'] as const)('never creates an order or payment link for %s when inventory cannot be read', async (payment) => {
    m.stock.mockRejectedValueOnce(new Error('Shopify timeout'))
    await createShopifyOrderFromChat({
      db: db as never, accountId: 'a', contactId: 'c', conversationId: 'conv', configOwnerUserId: 'u',
      proposal: { items: [{ name: 'Producto', qty: 1 }], fullName: 'Ana', phone: '50242883689', address: 'Mixco', departamento: 'Guatemala', payment },
      handoff: m.handoff, sendText: m.send,
    })
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining('No se pudieron verificar las existencias'))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
  })
})
