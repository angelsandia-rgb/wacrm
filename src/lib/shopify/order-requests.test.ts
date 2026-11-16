import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  stock: [] as string[],
  coverage: null as Record<string, string[] | '*'> | null,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  jobs: [] as { key: string; payload: Record<string, unknown> }[],
  settled: { id: 'r1' } as Record<string, unknown> | null,
  rpcs: [] as Record<string, unknown>[],
  // Queue of results for submit_shopify_order_request (default: a new row).
  rpcResults: [] as { data: unknown; error: { message: string } | null }[],
}))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  loadShopifyConfig: async () => ({ shop: 's', token: 't', shippingCoverage: m.coverage }),
  outOfStockTitles: async () => m.stock,
}))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: async () => ({ contactId: 'ct1', conversationId: 'cv1' }) }))
const sweep = vi.hoisted(() => vi.fn())
vi.mock('./notification-jobs', () => ({ runOrderNotificationSweep: sweep }))

import {
  finishOrderRequest, parseOrderForm, pendingRequestsPrompt, pickAnsweredRequest, settleOrderRequest, submitOrderForm,
  type PendingOrderRequest,
} from './order-requests'

function db() {
  const chain = (table: string) => {
    let op = 'select'
    const c: Record<string, unknown> = {
      select: () => c, eq: () => c, in: () => c, gte: () => c, order: () => c, limit: () => c,
      update: (row: Record<string, unknown>) => { op = 'update'; m.updates.push({ table, ...row }); return c },
      insert: (row: Record<string, unknown>) => { op = 'insert'; m.inserts.push({ table, ...row }); return c },
      single: async () => ({ data: { id: 'r1' }, error: null }),
      maybeSingle: async () => ({ data: table === 'accounts' ? { default_currency: 'GTQ' } : op === 'update' ? m.settled : null, error: null }),
      then: (ok: (v: unknown) => unknown) => ok({
        data: table === 'products' ? [{ name: 'Lámpara', price: 199, shopify_variant_id: 'gid://shopify/ProductVariant/7' }] : null, error: null,
      }),
    }
    return c
  }
  const rpc = async (_fn: string, args: Record<string, unknown>) => {
    m.rpcs.push(args)
    return m.rpcResults.shift() ?? { data: { id: 'r1', purchaseId: 'p1', revision: 1, created: true }, error: null }
  }
  return { from: chain, rpc } as never
}

const form = {
  items: [{ variantId: '7', quantity: 2 }], fullName: 'Ana López', phone: '5485 2732',
  address: '4a calle 8-20 zona 1', reference: 'frente al parque', municipio: 'Mixco', departamento: 'Guatemala',
}

beforeEach(() => { m.coverage = null; m.stock = []; m.inserts = []; m.updates = []; m.jobs = []; m.settled = { id: 'r1' }; m.rpcs = []; m.rpcResults = []; sweep.mockReset() })

describe('parseOrderForm', () => {
  it('accepts a complete form', () => {
    expect(parseOrderForm(form)).toMatchObject({ phone: '5485 2732', items: [{ variantId: '7', quantity: 2 }] })
    expect(parseOrderForm({ ...form, nit: ' 1234567-8 ' })).toMatchObject({ nit: '1234567-8', payment: 'cod' })
    expect(parseOrderForm({ ...form, payment: 'card' })).toMatchObject({ payment: 'card' })
    expect(parseOrderForm({ ...form, payment: 'bitcoin' })).toMatchObject({ payment: 'cod' })
  })
  it('rejects bad phones, unknown departamentos and a capital municipio in another departamento', () => {
    expect(parseOrderForm({ ...form, phone: '123' })).toEqual({ error: expect.stringContaining('teléfono') })
    expect(parseOrderForm({ ...form, departamento: 'Guantemala' })).toEqual({ error: expect.stringContaining('departamento') })
    expect(parseOrderForm({ ...form, departamento: 'Escuintla' })).toEqual({ error: expect.stringContaining('Mixco pertenece a Guatemala') })
    expect(parseOrderForm({ ...form, municipio: 'Guantemala' })).toEqual({ error: expect.stringContaining('Elija su municipio') })
    // Stored as the canonical names, whatever was typed.
    expect(parseOrderForm({ ...form, municipio: 'san jose pinula', departamento: 'guatemala' })).toMatchObject({ municipio: 'San José Pinula', departamento: 'Guatemala' })
    expect(parseOrderForm({ ...form, items: [{ variantId: '7', quantity: 99 }] })).toEqual({ error: expect.stringContaining('cantidades') })
    expect(parseOrderForm({ ...form, items: [{ variantId: 'abc', quantity: 1 }] })).toEqual({ error: expect.stringContaining('productos') })
  })
})

describe('submitOrderForm', () => {
  it('saves a validated request and asks on WhatsApp — no Shopify order is created', async () => {
    const res = await submitOrderForm(db(), 'a1', parseOrderForm(form) as never)
    expect(res).toEqual({ ok: true })
    // The request and its WhatsApp question go to the database together.
    expect(m.rpcs).toHaveLength(1)
    expect(m.rpcs[0]).toMatchObject({
      p_contact_id: 'ct1', p_total: 398, p_currency: 'GTQ',
      // What the customer accepts: the order is placed with exactly this or not at all.
      p_terms: { lines: [{ variantId: 'gid://shopify/ProductVariant/7', quantity: 2, price: 199 }], currency: 'GTQ', total: 398 },
      p_proposal: {
        items: [{ name: 'Lámpara', qty: 2 }], phone: '+50254852732', municipio: 'Mixco', departamento: 'Guatemala',
        payment: 'cod', address: '4a calle 8-20 zona 1. Ref.: frente al parque',
      },
      // A new purchase: it does not name, and so cannot replace, another one.
      p_purchase_id: null, p_idempotency_key: null,
      p_job_payload: { conversationId: 'cv1', template: { names: ['confirmar_pedido'], params: ['Ana', 'de 2 x Lámpara', 'Q398'] } },
    })
    // No request of this contact is superseded from here any more.
    expect(m.updates).toEqual([])
    expect(sweep).toHaveBeenCalledWith(expect.anything(), 'a1', 'request:r1:ask')
  })
  it('a repeated submit (same key) asks only once', async () => {
    m.rpcResults = [{ data: { id: 'r1', purchaseId: 'p1', revision: 1, created: false }, error: null }]
    expect(await submitOrderForm(db(), 'a1', parseOrderForm({ ...form, idempotencyKey: 'abcdef123456' }) as never)).toEqual({ ok: true })
    expect(m.rpcs[0]).toMatchObject({ p_idempotency_key: 'abcdef123456' })
    expect(sweep).not.toHaveBeenCalled()
  })
  it('a submit that raced itself is retried once and returns the winner', async () => {
    m.rpcResults = [{ data: null, error: { message: 'Concurrent submit' } }, { data: { id: 'r1', purchaseId: 'p1', revision: 1, created: false }, error: null }]
    expect(await submitOrderForm(db(), 'a1', parseOrderForm({ ...form, idempotencyKey: 'abcdef123456' }) as never)).toEqual({ ok: true })
    expect(m.rpcs).toHaveLength(2)
  })
  it('an edit names its purchase; one already in creation is refused, not duplicated', async () => {
    const purchaseId = '11111111-2222-3333-4444-555555555555'
    m.rpcResults = [{ data: null, error: { message: 'Purchase is not editable' } }]
    expect(await submitOrderForm(db(), 'a1', parseOrderForm({ ...form, purchaseId }) as never)).toMatchObject({ status: 409 })
    expect(m.rpcs[0]).toMatchObject({ p_purchase_id: purchaseId })
    expect(sweep).not.toHaveBeenCalled()
  })
  it.each([
    ['an excluded municipio', { Guatemala: ['Guatemala', 'Villa Nueva'] }],
    ['an excluded departamento', { Sacatepéquez: '*' as const }],
  ])('refuses %s of the configured coverage without saving or messaging', async (_c, coverage) => {
    m.coverage = coverage
    expect(await submitOrderForm(db(), 'a1', parseOrderForm(form) as never)).toEqual({ error: expect.stringContaining('no hacemos envíos a Mixco'), status: 422 })
    expect(m.rpcs).toEqual([])
  })
  it('refuses products out of stock and unknown variants without saving anything', async () => {
    m.stock = ['Lámpara']
    expect(await submitOrderForm(db(), 'a1', parseOrderForm(form) as never)).toMatchObject({ status: 409 })
    m.stock = []
    expect(await submitOrderForm(db(), 'a1', parseOrderForm({ ...form, items: [{ variantId: '8', quantity: 1 }] }) as never)).toMatchObject({ status: 409 })
    expect(m.rpcs).toEqual([])
  })
})

describe('pickAnsweredRequest — which purchase a "sí" is about', () => {
  const req = (id: string, ref: string, askDeliveredAt: string | null): PendingOrderRequest => ({
    id, ref, askDeliveredAt, terms: null, summary: `resumen ${id}`,
    proposal: { items: [], fullName: 'Ana', phone: '+50254852732', address: 'x', departamento: 'Guatemala', payment: 'cod' },
  })
  const at = (min: number) => new Date(Date.UTC(2026, 10, 16, 12, min)).toISOString()
  const said = (min: number, quotedMin?: number) => ({ at: at(min), quotedAt: quotedMin === undefined ? null : at(quotedMin) })

  it('accepts the only purchase when its summary was delivered before the answer', () => {
    expect(pickAnsweredRequest([req('A', 'AAAA', at(0))], undefined, said(5))?.id).toBe('A')
  })
  it('never accepts a summary that had not reached WhatsApp', () => {
    expect(pickAnsweredRequest([req('A', 'AAAA', null)], undefined, said(5))).toBeNull()
    expect(pickAnsweredRequest([req('A', 'AAAA', at(10))], undefined, said(5))).toBeNull()
  })
  it('two purchases waiting: a bare "sí" picks neither; a named one picks exactly that', () => {
    const two = [req('B', 'BBBB', at(2)), req('A', 'AAAA', at(0))]
    expect(pickAnsweredRequest(two, undefined, said(5))).toBeNull()
    expect(pickAnsweredRequest(two, 'aaaa', said(5))?.id).toBe('A')
    expect(pickAnsweredRequest(two, 'ZZZZ', said(5))).toBeNull()
  })
  it('an answer quoting a message older than the current summary is not consent to it', () => {
    // Summary A was replaced by B (delivered at minute 10); the customer answers A's old message.
    expect(pickAnsweredRequest([req('B', 'BBBB', at(10))], undefined, said(12, 0))).toBeNull()
    // Quoting the current summary itself is fine.
    expect(pickAnsweredRequest([req('B', 'BBBB', at(10))], undefined, said(12, 10))?.id).toBe('B')
  })
  it('describes one purchase plainly and several with their codes', () => {
    expect(pendingRequestsPrompt([])).toBeNull()
    expect(pendingRequestsPrompt([req('A', 'AAAA', at(0))])).toBe('resumen A')
    expect(pendingRequestsPrompt([req('B', 'BBBB', at(2)), req('A', 'AAAA', at(0))])).toContain('[BBBB] resumen B | [AAAA] resumen A')
  })
})

describe('settleOrderRequest', () => {
  it('settles a pending request once; a second answer finds nothing to settle', async () => {
    expect(await settleOrderRequest(db(), 'a1', 'r1', 'processing')).toBe(true)
    m.settled = null
    expect(await settleOrderRequest(db(), 'a1', 'r1', 'processing')).toBe(false)
  })
})

describe('finishOrderRequest', () => {
  it('records the created order, or holds the request with its reason — never back to pending', async () => {
    await finishOrderRequest(db(), 'a1', 'r1', { status: 'confirmed', orderId: 'gid://shopify/Order/9', orderName: '#1009' })
    await finishOrderRequest(db(), 'a1', 'r1', { status: 'held', note: 'Shopify no respondió' })
    expect(m.updates).toEqual([
      { table: 'shopify_order_requests', status: 'confirmed', order_id: 'gid://shopify/Order/9', order_name: '#1009' },
      { table: 'shopify_order_requests', status: 'held', outcome_note: 'Shopify no respondió' },
    ])
  })
})
