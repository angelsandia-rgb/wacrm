import { createHmac } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOrderInput, createRecurrenteCheckout, createShopifyOrder, departamentoCode, describeOrderStatuses,
  fetchClientCredentialsToken, loadShopifyConfig, mapShopifyProduct, normalizeGtPhone, shopifyGraphql, verifyShopifyHmac,
} from './api'
import { parseShopifyOrderPayload } from '@/lib/ai/generate'
import { ORDER_STATUS_QUESTION_RE } from '@/lib/ai/auto-reply'
import type { SupabaseClient } from '@supabase/supabase-js'

// Identity cipher so stored rows can be written as plain text below.
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }))

const variant = (over: Partial<{ inventoryQuantity: number; inventoryPolicy: 'DENY' | 'CONTINUE'; tracked: boolean }> = {}) => ({
  id: 'gid://shopify/ProductVariant/1',
  price: '199.00',
  inventoryQuantity: over.inventoryQuantity ?? 5,
  inventoryPolicy: over.inventoryPolicy ?? 'DENY',
  inventoryItem: { tracked: over.tracked ?? true },
})
const product = (v: ReturnType<typeof variant>) => ({
  title: ' Lámpara Ceiba ',
  description: 'Luz  cálida\n para tu sala',
  featuredMedia: { preview: { image: { url: 'https://cdn/x.jpg' } } },
  variants: { nodes: [v] },
})

describe('mapShopifyProduct', () => {
  it('maps price, image, plain description', () => {
    expect(mapShopifyProduct(product(variant()))).toEqual({
      shopify_variant_id: 'gid://shopify/ProductVariant/1', name: 'Lámpara Ceiba', price: 199,
      description: 'Luz cálida para tu sala', image_url: 'https://cdn/x.jpg', is_active: true,
    })
  })
  it('deactivates tracked zero-stock variants unless overselling is allowed', () => {
    expect(mapShopifyProduct(product(variant({ inventoryQuantity: 0 })))?.is_active).toBe(false)
    expect(mapShopifyProduct(product(variant({ inventoryQuantity: 0, inventoryPolicy: 'CONTINUE' })))?.is_active).toBe(true)
    expect(mapShopifyProduct(product(variant({ inventoryQuantity: 0, tracked: false })))?.is_active).toBe(true)
  })
})

describe('buildOrderInput', () => {
  it('builds a pending COD order with the store gateway name and tag', () => {
    const input = buildOrderInput({
      lines: [{ variantId: 'gid://v/1', quantity: 2, price: 169, title: 'X' }],
      fullName: 'Ana María López', phone: '5555 1234', address: 'Zona 10, 5a avenida 1-23',
      departamento: 'Sacatepéquez', payment: 'cod', currency: 'GTQ',
    })
    expect(input.financialStatus).toBe('PENDING')
    expect(input.tags).toEqual(['chat-sandia'])
    expect(input.phone).toBe('+50255551234')
    expect(input.shippingAddress).toMatchObject({ firstName: 'Ana María', lastName: 'López', provinceCode: 'SAC', countryCode: 'GT' })
    expect(input.transactions).toEqual([{
      kind: 'SALE', status: 'PENDING', gateway: 'Pago contra entrega (COD)',
      amountSet: { shopMoney: { amount: '338.00', currencyCode: 'GTQ' } },
    }])
  })
})

describe('helpers', () => {
  it('normalizes GT phones and departamentos', () => {
    expect(normalizeGtPhone('+502 5555-1234')).toBe('+50255551234')
    expect(departamentoCode('peten')).toBe('PET')
    expect(departamentoCode('Narnia')).toBeUndefined()
  })
  it('verifies the webhook HMAC', () => {
    const body = '{"id":1}'
    const sig = createHmac('sha256', 's3cret').update(body).digest('base64')
    expect(verifyShopifyHmac(body, sig, 's3cret')).toBe(true)
    expect(verifyShopifyHmac(body + ' ', sig, 's3cret')).toBe(false)
    expect(verifyShopifyHmac(body, null, 's3cret')).toBe(false)
  })
})

describe('card orders', () => {
  const cfg = {
    shop: 'x.myshopify.com', token: 't', ordersLive: true, webhookSecret: null,
    templateName: null, templateLanguage: 'es', recurrenteSecretKey: 'sk_test_1',
  }
  const req = {
    lines: [{ variantId: 'gid://v/1', quantity: 1, price: 229, title: 'X' }],
    fullName: 'Ana López', phone: '55551234', address: 'Zona 1', departamento: 'Guatemala',
    payment: 'card' as const, currency: 'GTQ',
  }
  afterEach(() => vi.unstubAllGlobals())

  it('stay drafts tagged pago-tarjeta even with real orders on (Dropi must not ship or collect cash)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/9', name: '#D9' }, userErrors: [] } },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const order = await createShopifyOrder(cfg, req)
    expect(order).toEqual({ id: 'gid://shopify/DraftOrder/9', name: '#D9', draft: true, total: 229 })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.query).toContain('draftOrderCreate')
    expect(body.variables.input.tags).toEqual(['chat-sandia', 'pago-tarjeta'])
  })

  it('asks Recurrente for the exact total in cents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'ch_1', checkout_url: 'https://app.recurrente.com/checkout/ch_1' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const url = await createRecurrenteCheckout('sk_test_1', { title: 'Pedido #D9', total: 458, currency: 'GTQ', orderId: 'gid://shopify/DraftOrder/9' })
    expect(url).toBe('https://app.recurrente.com/checkout/ch_1')
    const [endpoint, init] = fetchMock.mock.calls[0]
    expect(endpoint).toBe('https://app.recurrente.com/api/checkouts')
    expect(init.headers['X-SECRET-KEY']).toBe('sk_test_1')
    expect(JSON.parse(init.body).items).toEqual([{ name: 'Pedido #D9', currency: 'GTQ', amount_in_cents: 45800, quantity: 1 }])
  })
})

describe('order status', () => {
  it('describes payment, fulfillment and Dropi tracking', () => {
    expect(describeOrderStatuses([{
      name: '#1042', createdAt: '2026-10-30T10:00:00Z', cancelledAt: null,
      displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'FULFILLED', phone: null, shippingAddress: null,
      fulfillments: [{ displayStatus: 'IN_TRANSIT', trackingInfo: [{ company: 'Cargo Expreso', number: 'CE123', url: null }] }],
    }])).toBe('- #1042 (creado 2026-10-30): pago PENDING, preparación FULFILLED, entrega IN_TRANSIT, guía Cargo Expreso CE123')
  })
  it('gates the lookup on order-status questions only', () => {
    for (const q of ['¿dónde va mi pedido?', 'me pasa la guía', 'ya lo enviaron?', 'pedido #1042', '¿cuándo llega?']) {
      expect(ORDER_STATUS_QUESTION_RE.test(q)).toBe(true)
    }
    for (const q of ['hola, precio de la lámpara', 'quiero comprar dos']) expect(ORDER_STATUS_QUESTION_RE.test(q)).toBe(false)
  })
})

describe('parseShopifyOrderPayload', () => {
  it('parses a complete marker', () => {
    expect(parseShopifyOrderPayload('Lámpara Ceiba:2,Cojín: 1|Ana López|55551234|Zona 1, 6a calle|Guatemala|contra entrega')).toEqual({
      items: [{ name: 'Lámpara Ceiba', qty: 2 }, { name: 'Cojín', qty: 1 }],
      fullName: 'Ana López', phone: '55551234', address: 'Zona 1, 6a calle', departamento: 'Guatemala', payment: 'cod',
    })
    expect(parseShopifyOrderPayload('Cojín:1|Ana|55551234|Zona 1|Guatemala|tarjeta')?.payment).toBe('card')
  })
  it('rejects a marker with a missing field', () => {
    expect(parseShopifyOrderPayload('Cojín:1|Ana|55551234|Zona 1|Guatemala|')).toBeNull()
    expect(parseShopifyOrderPayload('Cojín:1|Ana||Zona 1|Guatemala|cod')).toBeNull()
  })
})

describe('client credentials (Dev Dashboard apps)', () => {
  afterEach(() => vi.unstubAllGlobals())
  const tokenRes = (token: string) => new Response(JSON.stringify({ access_token: token, scope: 'read_products', expires_in: 86399 }))

  it('posts the form-encoded grant without scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenRes('tok_1'))
    vi.stubGlobal('fetch', fetchMock)
    const { token, expiresAt } = await fetchClientCredentialsToken('x.myshopify.com', 'cid', 'csecret')
    expect(token).toBe('tok_1')
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(86_000_000)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://x.myshopify.com/admin/oauth/access_token')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ grant_type: 'client_credentials', client_id: 'cid', client_secret: 'csecret' })
  })

  it('explains shop_not_permitted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'shop_not_permitted' }), { status: 400 })))
    await expect(fetchClientCredentialsToken('x.myshopify.com', 'cid', 's')).rejects.toThrow(/misma organización/)
  })

  it('refreshes once on a 401 and retries the query', async () => {
    const ok = new Response(JSON.stringify({ data: { shop: { name: 'Casa Ceiba' } } }))
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(ok)
    vi.stubGlobal('fetch', fetchMock)
    const cfg = { shop: 'x.myshopify.com', token: 'old', refreshToken: vi.fn().mockResolvedValue('new') }
    await expect(shopifyGraphql(cfg, '{ shop { name } }')).resolves.toEqual({ shop: { name: 'Casa Ceiba' } })
    expect(cfg.refreshToken).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[1][1].headers['X-Shopify-Access-Token']).toBe('new')
  })

  function fakeDb(row: Record<string, unknown>) {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }),
        update,
      }),
    } as unknown as SupabaseClient
    return { db, update }
  }
  const row = (expiresInMs: number) => ({
    shop_domain: 'x.myshopify.com', access_token: 'enc:cached', client_id: 'cid', client_secret: 'enc:csecret',
    access_token_expires_at: new Date(Date.now() + expiresInMs).toISOString(), orders_live: false,
  })

  it('uses the cached token while it is fresh', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { db, update } = fakeDb(row(3_600_000))
    expect((await loadShopifyConfig(db, 'acc'))?.token).toBe('cached')
    expect(update).not.toHaveBeenCalled()
  })

  it('refreshes and caches (encrypted) a token about to expire', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenRes('fresh')))
    const { db, update } = fakeDb(row(30_000))
    expect((await loadShopifyConfig(db, 'acc'))?.token).toBe('fresh')
    expect(update.mock.calls[0][0]).toMatchObject({ access_token: 'enc:fresh' })
  })
})
