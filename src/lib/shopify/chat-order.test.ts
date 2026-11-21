import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  stock: vi.fn(), create: vi.fn(), attach: vi.fn(), handoff: vi.fn(), send: vi.fn(), checkout: vi.fn(), record: vi.fn(), failSave: false,
  cfg: { shop: 'store', token: 't' } as Record<string, unknown>,
}))
vi.mock('./card-payments', () => ({ recordCardCheckout: m.record }))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  loadShopifyConfig: async () => m.cfg,
  outOfStockTitles: m.stock, createShopifyOrder: m.create, attachOrderToDeal: m.attach, createRecurrenteCheckout: m.checkout,
}))
import { createShopifyOrderFromChat } from './chat-order'

function database() {
  const attempts = new Map<string, Record<string, unknown>>()
  const db = {
  // Mirrors claim_shopify_purchase_attempt (migration 185): one row per
  // purchase; a blocked attempt quarantines the whole conversation.
  rpc: async (_name: string, params: { p_account_id: string; p_conversation_id: string; p_purchase_key: string }) => {
    const key = `${params.p_account_id}:${params.p_purchase_key}`
    const blockedHere = [...attempts.entries()].some(([k, r]) => k !== key && r.conversation === params.p_conversation_id && r.status === 'blocked')
    if (blockedHere) return { data: { acquired: false, status: 'blocked' }, error: null }
    const row = attempts.get(key)
    if (row && row.status !== 'failed') return { data: { acquired: false, status: row.status, orderName: row.order_name }, error: null }
    attempts.set(key, { status: 'processing', attempt_token: key, conversation: params.p_conversation_id })
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
        const row = attempts.get(`${filters.account_id}:${filters.purchase_key}`)
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
/** The single purchase attempt these tests create. */
const only = () => { const rows = [...fixture.attempts.values()]; expect(rows).toHaveLength(1); return rows[0] }
beforeEach(() => {
  vi.clearAllMocks()
  fixture = database()
  m.failSave = false
  m.cfg = { shop: 'store', token: 't' }
  m.checkout.mockResolvedValue({ id: 'ch_c1', url: 'https://pay.example/c1' })
  m.record.mockReset()
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
  it('the same purchase re-emitted (even with the address reworded) is placed once', async () => {
    await run()
    await run({ proposal: { items: [{ name: ' producto ', qty: 1 }], fullName: 'Ana López', phone: '4288 3689', address: 'Mixco, zona 1', departamento: 'Guatemala', payment: 'cod' } })
    expect(m.create).toHaveBeenCalledTimes(1)
  })
  it('a second, different purchase in the same chat is placed too', async () => {
    await run()
    await run({ proposal: { items: [{ name: 'Producto', qty: 2 }], fullName: 'Ana', phone: '50242883689', address: 'Mixco', departamento: 'Guatemala', payment: 'cod' } })
    expect(m.create).toHaveBeenCalledTimes(2)
  })
  it('an attempt with an unknown result keeps the whole chat blocked, other purchases included', async () => {
    m.create.mockRejectedValueOnce(new Error('connection interrupted after request'))
    await run()
    await run({ proposal: { items: [{ name: 'Producto', qty: 3 }], fullName: 'Ana', phone: '50242883689', address: 'Mixco', departamento: 'Guatemala', payment: 'cod' } })
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(m.handoff).toHaveBeenLastCalledWith(expect.stringContaining('resultado pendiente de verificar'))
  })
  it('a form request is locked by its own id', async () => {
    const calls: string[] = []
    const db = fixture.db as unknown as { rpc: (n: string, p: { p_purchase_key: string }) => unknown }
    const rpc = db.rpc
    db.rpc = (n, p) => { calls.push(p.p_purchase_key); return rpc(n, p as never) }
    await run({ requestId: 'req-9', accepted: { lines: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 1, price: 300 }], currency: 'GTQ', total: 300 } })
    expect(calls).toEqual(['request:req-9'])
  })
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
    expect(only()).toMatchObject({ status: 'succeeded', order_id: 'gid://shopify/Order/1' })
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
    expect(only()?.status).toBe('blocked')
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
    expect(only()?.status).toBe('failed')
    await run()
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(only()?.status).toBe('succeeded')
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
    // Recorded so the payment is found even if its webhook never arrives.
    expect(m.record).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ checkoutId: 'ch_c1', draftId: 'gid://shopify/DraftOrder/1', amount: 300, currency: 'GTQ' }))
    expect(m.send).toHaveBeenCalledWith(expect.stringContaining('https://pay.example/c1'))
  })
})

describe('the charged total is the one the customer accepted', () => {
  it('neither confirms nor charges when Shopify prices the order differently from the accepted summary', async () => {
    m.cfg = { shop: 'store', token: 't', ordersLive: true, recurrenteSecretKey: 'sk_live_x', recurrenteWebhookSecret: 'whsec_x' }
    m.create.mockResolvedValue({ id: 'gid://shopify/DraftOrder/1', name: '#D1', draft: true, total: 350, catalogTotal: 300 })
    await run({ proposal: { items: [{ name: 'Producto', qty: 1 }], fullName: 'Ana', phone: '50242883689', address: 'Mixco', departamento: 'Guatemala', payment: 'card' } })
    expect(m.checkout).not.toHaveBeenCalled()
    expect(m.send).toHaveBeenCalledWith(expect.stringContaining('verificando el total'))
    expect(m.send).not.toHaveBeenCalledWith(expect.stringContaining('Q'))
    expect(m.handoff).toHaveBeenCalledWith(expect.stringMatching(/Q350[\s\S]*Q300/))
  })
})

describe('delivery municipio', () => {
  const order = (departamento: string, municipio: string) => run({ proposal: { items: [{ name: 'Producto', qty: 1 }], fullName: 'Ana', phone: '50242883689', address: 'Zona 1', departamento, municipio, payment: 'cod' } })
  it('passes the municipio to Shopify and shows it in the confirmation', async () => {
    await order('Guatemala', 'Mixco')
    expect(m.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ departamento: 'Guatemala', municipio: 'Mixco' }))
    expect(m.send).toHaveBeenCalledWith(expect.stringContaining('Envío a Zona 1, Mixco, Guatemala.'))
  })
  it('creates nothing when the municipio belongs to another departamento', async () => {
    await order('Escuintla', 'Villa Nueva')
    expect(m.create).not.toHaveBeenCalled()
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining('pertenece a Guatemala'))
  })
  it('creates nothing for a place that is not a municipio (typo, aldea, zona)', async () => {
    await order('Guatemala', 'Guantemala')
    expect(m.create).not.toHaveBeenCalled()
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining('no es un municipio'))
  })
})

describe('form request: order only on the terms the customer accepted', () => {
  const v1 = 'gid://shopify/ProductVariant/1'
  const accepted = (price: number, extra: Partial<{ currency: string; variantId: string }> = {}) => ({
    lines: [{ variantId: extra.variantId ?? v1, quantity: 2, price }], currency: extra.currency ?? 'GTQ', total: price * 2,
  })
  it('places the accepted variant, quantity and price when the catalog still matches', async () => {
    await run({ accepted: accepted(300) })
    expect(m.create).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      lines: [{ variantId: v1, quantity: 2, price: 300, title: 'Producto' }], currency: 'GTQ',
    }))
  })
  it.each([
    ['a price increase', accepted(250)],
    ['a price decrease', accepted(350)],
    ['another currency', accepted(300, { currency: 'USD' })],
    ['an item no longer sold', accepted(300, { variantId: 'gid://shopify/ProductVariant/2' })],
  ])('%s: no order, no payment link, the customer is told and a person re-quotes', async (_case, terms) => {
    await run({ accepted: terms, proposal: { items: [{ name: 'Producto', qty: 2 }], fullName: 'Ana', phone: '50242883689', address: 'Mixco', departamento: 'Guatemala', payment: 'card' } })
    expect(m.create).not.toHaveBeenCalled()
    expect(m.checkout).not.toHaveBeenCalled()
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining('cambió lo que el cliente aceptó'))
    expect(m.send).toHaveBeenCalledWith(expect.stringContaining('total actualizado'))
  })
})

describe('commercial coverage at creation time', () => {
  it.each([
    ['outside', { Guatemala: ['Villa Nueva'] }, { departamento: 'Guatemala', municipio: 'Mixco' }, 'fuera de la cobertura'],
    ['ambiguous', { Guatemala: ['Mixco'] }, { departamento: 'Guatemala' }, 'falta el municipio'],
  ])('%s (incl. coverage changed after the form): no order, no link', async (_c, coverage, where, reason) => {
    m.cfg = { shop: 'store', token: 't', shippingCoverage: coverage }
    await run({ proposal: { items: [{ name: 'Producto', qty: 1 }], fullName: 'Ana', phone: '50242883689', address: '4a calle', payment: 'card', ...where } as never })
    expect(m.create).not.toHaveBeenCalled()
    expect(m.checkout).not.toHaveBeenCalled()
    expect(m.handoff).toHaveBeenCalledWith(expect.stringContaining(reason))
  })
  it('a covered address is placed normally', async () => {
    m.cfg = { shop: 'store', token: 't', shippingCoverage: { Guatemala: ['Mixco'] } }
    await run({ proposal: { items: [{ name: 'Producto', qty: 1 }], fullName: 'Ana', phone: '50242883689', address: '4a calle', departamento: 'Guatemala', municipio: 'Mixco', payment: 'cod' } })
    expect(m.create).toHaveBeenCalledTimes(1)
  })
})
