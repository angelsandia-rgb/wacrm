import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  stock: [] as string[],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  jobs: [] as { key: string; payload: Record<string, unknown> }[],
  settled: { id: 'r1' } as Record<string, unknown> | null,
}))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  loadShopifyConfig: async () => ({ shop: 's', token: 't' }),
  outOfStockTitles: async () => m.stock,
}))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: async () => ({ contactId: 'ct1', conversationId: 'cv1' }) }))
vi.mock('./notification-jobs', () => ({
  enqueueOrderNotification: async (_db: unknown, _a: string, key: string, payload: Record<string, unknown>) => { m.jobs.push({ key, payload }) },
  runOrderNotificationSweep: vi.fn(),
}))

import { parseOrderForm, settleOrderRequest, submitOrderForm } from './order-requests'

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
  return { from: chain } as never
}

const form = {
  items: [{ variantId: '7', quantity: 2 }], fullName: 'Ana López', phone: '5485 2732',
  address: '4a calle 8-20 zona 1', reference: 'frente al parque', municipio: 'Mixco', departamento: 'Guatemala',
}

beforeEach(() => { m.stock = []; m.inserts = []; m.updates = []; m.jobs = []; m.settled = { id: 'r1' } })

describe('parseOrderForm', () => {
  it('accepts a complete form', () => {
    expect(parseOrderForm(form)).toMatchObject({ phone: '5485 2732', items: [{ variantId: '7', quantity: 2 }] })
  })
  it('rejects bad phones, unknown departamentos and a capital municipio in another departamento', () => {
    expect(parseOrderForm({ ...form, phone: '123' })).toEqual({ error: expect.stringContaining('teléfono') })
    expect(parseOrderForm({ ...form, departamento: 'Guantemala' })).toEqual({ error: expect.stringContaining('departamento') })
    expect(parseOrderForm({ ...form, departamento: 'Escuintla' })).toEqual({ error: expect.stringContaining('municipio') })
    expect(parseOrderForm({ ...form, items: [{ variantId: '7', quantity: 99 }] })).toEqual({ error: expect.stringContaining('cantidades') })
    expect(parseOrderForm({ ...form, items: [{ variantId: 'abc', quantity: 1 }] })).toEqual({ error: expect.stringContaining('productos') })
  })
})

describe('submitOrderForm', () => {
  it('saves a validated request and asks on WhatsApp — no Shopify order is created', async () => {
    const res = await submitOrderForm(db(), 'a1', parseOrderForm(form) as never)
    expect(res).toEqual({ ok: true })
    const request = m.inserts.find((r) => r.table === 'shopify_order_requests')!
    expect(request).toMatchObject({
      contact_id: 'ct1', total: 398, currency: 'GTQ',
      proposal: {
        items: [{ name: 'Lámpara', qty: 2 }], phone: '+50254852732', municipio: 'Mixco', departamento: 'Guatemala',
        payment: 'cod', address: '4a calle 8-20 zona 1. Ref.: frente al parque',
      },
    })
    // The previous pending request of this contact is superseded first.
    expect(m.updates[0]).toMatchObject({ table: 'shopify_order_requests', status: 'superseded' })
    expect(m.jobs[0]).toMatchObject({ key: 'request:r1:ask', payload: { template: { names: ['confirmar_pedido'], params: ['Ana', 'de 2 x Lámpara', 'Q398'] } } })
  })
  it('refuses products out of stock and unknown variants without saving anything', async () => {
    m.stock = ['Lámpara']
    expect(await submitOrderForm(db(), 'a1', parseOrderForm(form) as never)).toMatchObject({ status: 409 })
    m.stock = []
    expect(await submitOrderForm(db(), 'a1', parseOrderForm({ ...form, items: [{ variantId: '8', quantity: 1 }] }) as never)).toMatchObject({ status: 409 })
    expect(m.inserts).toEqual([])
    expect(m.jobs).toEqual([])
  })
})

describe('settleOrderRequest', () => {
  it('settles a pending request once; a second answer finds nothing to settle', async () => {
    expect(await settleOrderRequest(db(), 'a1', 'r1', 'confirmed')).toBe(true)
    m.settled = null
    expect(await settleOrderRequest(db(), 'a1', 'r1', 'confirmed')).toBe(false)
  })
})
