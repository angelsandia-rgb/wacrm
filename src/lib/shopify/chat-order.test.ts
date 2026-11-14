import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  stock: vi.fn(), create: vi.fn(), attach: vi.fn(), handoff: vi.fn(), send: vi.fn(), checkout: vi.fn(), failSave: false,
  cfg: { shop: 'store', token: 't' } as Record<string, unknown>,
}))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  loadShopifyConfig: async () => m.cfg,
  outOfStockTitles: m.stock, createShopifyOrder: m.create, attachOrderToDeal: m.attach, createRecurrenteCheckout: m.checkout,
}))
import { createShopifyOrderFromChat } from './chat-order'

function database() {
  const attempts = new Map<string, Record<string, unknown>>()
  const db = {
  rpc: async (_name: string, params: { p_account_id: string; p_conversation_id: string }) => {
    const key = `${params.p_account_id}:${params.p_conversation_id}`
    const row = attempts.get(key)
    if (row && row.status !== 'failed') return { data: { acquired: false, status: row.status, orderName: row.order_name }, error: null }
    attempts.set(key, { status: 'processing', attempt_token: key })
    return { data: { acquired: true, token: key, status: 'processing' }, error: null }
  },
  from(table: string) {
    const filters: Record<string, unknown> = {}
    let update: Record<string, unknown> | null = null
    const c = {
      select: () => c, contains: () => c, gte: () => c, limit: () => c, not: () => c, insert: () => c,
      eq: (key: string, value: unknown) => { filters[key] = value; return c },
      update: (value: Record<string, unknown>) => { update = value; return c },
      maybeSingle: async () => {
        if (table === 'accounts') return { data: { default_currency: 'GTQ' }, error: null }
        if (m.failSave) return { data: null, error: { message: 'database write unavailable' } }
        const row = attempts.get(`${filters.account_id}:${filters.conversation_id}`)
        if (row && row.attempt_token === filters.attempt_token) Object.assign(row, update)
        return { data: row ?? null, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: table === 'products'
        ? [{ name: 'Producto', price: 300, shopify_variant_id: 'gid://shopify/ProductVariant/1' }] : [] }),
    }
    return c
  },
}
  return { db, attempts }
}
let fixture = database()
beforeEach(() => {
  vi.clearAllMocks()
  fixture = database()
  m.failSave = false
  m.cfg = { shop: 'store', token: 't' }
  m.checkout.mockResolvedValue('https://pay.example/c1')
  m.stock.mockResolvedValue([])
  m.create.mockResolvedValue({ id: 'gid://shopify/Order/1', name: '#1001', draft: false, total: 300 })
})

const run = (extra: Partial<Parameters<typeof createShopifyOrderFromChat>[0]> = {}) => createShopifyOrderFromChat({
  db: fixture.db as never, accountId: 'a', contactId: 'c', conversationId: 'conv', configOwnerUserId: 'u',
  proposal: { items: [{ name: 'Producto', qty: 1 }], fullName: 'Ana', phone: '50242883689', address: 'Mixco', departamento: 'Guatemala', payment: 'cod' },
  handoff: m.handoff, sendText: m.send, ...extra,
})
describe('order inventory safety', () => {
  it.each(['cod', 'card'] as const)('never creates an order or payment link for %s when inventory cannot be read', async (payment) => {
    m.stock.mockRejectedValueOnce(new Error('Shopify timeout'))
    await createShopifyOrderFromChat({
      db: fixture.db as never, accountId: 'a', contactId: 'c', conversationId: 'conv', configOwnerUserId: 'u',
      proposal: { items: [{ name: 'Producto', qty: 1 }], fullName: 'Ana', phone: '50242883689', address: 'Mixco', departamento: 'Guatemala', payment },
      handoff: m.handoff, sendText: m.send,
    })
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining('No se pudieron verificar las existencias'))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
  })
})

describe('shared order creation guard', () => {
  it('allows only one Shopify request when AI and a manual order overlap', async () => {
    let finish!: (order: unknown) => void
    m.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = run()
    await vi.waitFor(() => expect(m.create).toHaveBeenCalledTimes(1))
    await run({ actor: 'agent' })
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining('está en proceso'))
    expect(m.create).toHaveBeenCalledTimes(1)
    finish({ id: 'gid://shopify/Order/1', name: '#1001', draft: false, total: 300 })
    await first
    expect(m.send).toHaveBeenCalledTimes(1)
    expect(fixture.attempts.get('a:conv')).toMatchObject({ status: 'succeeded', order_id: 'gid://shopify/Order/1' })
    await run()
    expect(m.create).toHaveBeenCalledTimes(1)
  })
  it('does not pause the first AI worker when another AI turn overlaps', async () => {
    let finish!: (order: unknown) => void
    m.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = run()
    await vi.waitFor(() => expect(m.create).toHaveBeenCalledTimes(1))
    await run()
    expect(m.handoff).not.toHaveBeenCalled()
    finish({ id: 'o', name: '#1001', draft: false, total: 300 })
    await first
  })
  it('never blindly repeats a mutation with an ambiguous network result', async () => {
    m.create.mockRejectedValueOnce(new Error('connection interrupted after request'))
    await run()
    expect(fixture.attempts.get('a:conv')?.status).toBe('blocked')
    await run()
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(m.handoff).toHaveBeenLastCalledWith(expect.stringContaining('resultado pendiente de verificar'))
  })
  it('keeps a known remote success guarded when saving its local result fails', async () => {
    m.failSave = true
    await run()
    await run({ actor: 'agent' })
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining('#1001 ya existe'))
  })
  it('allows a retry after a failure before sending any create request', async () => {
    m.stock.mockRejectedValueOnce(new Error('stock unavailable'))
    await run()
    expect(fixture.attempts.get('a:conv')?.status).toBe('failed')
    await run()
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(fixture.attempts.get('a:conv')?.status).toBe('succeeded')
  })
})

describe('card payment links follow the sales switch', () => {
  const card = (ordersLive: boolean) => {
    m.cfg = { shop: 'store', token: 't', ordersLive, recurrenteSecretKey: 'sk_live_x', recurrenteWebhookSecret: 'whsec_x' }
    m.create.mockResolvedValue({ id: 'gid://shopify/DraftOrder/1', name: '#D1', draft: true, total: 300 })
    return run({ proposal: { items: [{ name: 'Producto', qty: 1 }], fullName: 'Ana', phone: '50242883689', address: 'Mixco', departamento: 'Guatemala', payment: 'card' } })
  }
  it('emits no real payment link while "Crear pedidos reales" is off, and hands it to a person', async () => {
    await card(false)
    expect(m.checkout).not.toHaveBeenCalled()
    expect(m.send).toHaveBeenCalledWith(expect.not.stringContaining('https://'))
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining('Borrador #D1'))
  })
  it('emits the link for the exact total once sales are live', async () => {
    await card(true)
    expect(m.checkout).toHaveBeenCalledWith('sk_live_x', expect.objectContaining({ total: 300, currency: 'GTQ', orderId: 'gid://shopify/DraftOrder/1' }))
    expect(m.send).toHaveBeenCalledWith(expect.stringContaining('https://pay.example/c1'))
  })
})
