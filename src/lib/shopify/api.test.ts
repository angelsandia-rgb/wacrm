import { createHmac } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOrderInput, CARD_TAG, createRecurrenteCheckout, createShopifyOrder, departamentoCode, describeOrderStatuses, municipioMatchesDepartamento,
  completePaidDraftOrder, dropiSyncReason, fetchClientCredentialsToken, hasDropiSyncError, isCashOnDelivery, orderFullyDelivered, loadOrderStatuses, outOfStockTitles, pickOrderPipeline, pickOrderStage, pickPaidStage, pickForwardStage, trackingSentence, getRecurrenteCheckout, loadShopifyConfig, verifySvixSignature, mapShopifyProduct, normalizeGtPhone, shopifyGraphql, verifyShopifyHmac,
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
  it('sends Dropi the real municipio as the city, not the departamento', () => {
    const base = { lines: [{ variantId: 'gid://v/1', quantity: 1, price: 100, title: 'X' }], fullName: 'Ana', phone: '55551234', address: 'Zona 1', payment: 'cod' as const, currency: 'GTQ' }
    expect(buildOrderInput({ ...base, departamento: 'Guatemala', municipio: 'Mixco' }).shippingAddress).toMatchObject({ city: 'Mixco', provinceCode: 'GUA' })
    expect(buildOrderInput({ ...base, departamento: 'Alta Verapaz', municipio: 'Cobán' }).shippingAddress).toMatchObject({ city: 'Cobán', provinceCode: 'AVE' })
    // Older markers without municipio keep the previous behaviour.
    expect(buildOrderInput({ ...base, departamento: 'Mixco' }).shippingAddress).toMatchObject({ city: 'Mixco', provinceCode: 'GUA' })
  })
})

describe('helpers', () => {
  it('normalizes GT phones and departamentos', () => {
    expect(normalizeGtPhone('+502 5555-1234')).toBe('+50255551234')
    expect(departamentoCode('peten')).toBe('PET')
    expect(departamentoCode('Narnia')).toBeUndefined()
    // Casa Ceiba 2026-11-07: the model wrote the municipio as departamento
    expect(departamentoCode('Villa Canales')).toBe('GUA')
    expect(departamentoCode('Mixco')).toBe('GUA')
    expect(departamentoCode('Quetzaltenango')).toBe('QUE')
  })
  it('rejects only a municipio known to belong to another departamento', () => {
    expect(municipioMatchesDepartamento('Mixco', 'Guatemala')).toBe(true)
    expect(municipioMatchesDepartamento('Villa Nueva', 'Escuintla')).toBe(false)
    expect(municipioMatchesDepartamento('Cobán', 'Alta Verapaz')).toBe(true)
    expect(municipioMatchesDepartamento('Guantemala', 'Guatemala')).toBe(true) // unknown: Dropi decides, owner is alerted
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
    templateName: null, templateLanguage: 'es', recurrenteSecretKey: 'sk_test_1', recurrenteWebhookSecret: null,
  }
  const req = {
    lines: [{ variantId: 'gid://v/1', quantity: 1, price: 229, title: 'X' }],
    fullName: 'Ana López', phone: '55551234', address: 'Zona 1', departamento: 'Guatemala',
    payment: 'card' as const, currency: 'GTQ',
  }
  afterEach(() => vi.unstubAllGlobals())

  it('stay drafts tagged pago-tarjeta even with real orders on (Dropi must not ship or collect cash)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/9', name: '#D9', totalPriceSet: { shopMoney: { amount: '249.00' } } }, userErrors: [] } },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const order = await createShopifyOrder(cfg, req)
    // Shopify's own draft total is what may be charged; the catalog sum is kept to compare.
    expect(order).toEqual({ id: 'gid://shopify/DraftOrder/9', name: '#D9', draft: true, total: 249, catalogTotal: 229 })
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
    expect(parseShopifyOrderPayload('Cojín:1|Ana|55551234|Zona 1|Guatemala|tarjeta|Mixco')?.municipio).toBe('Mixco')
    expect(parseShopifyOrderPayload('Cojín:1|Ana|55551234|Zona 1|Guatemala|tarjeta')).not.toHaveProperty('municipio')
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

describe('Recurrente paid → Shopify order', () => {
  afterEach(() => vi.unstubAllGlobals())
  const secret = 'whsec_' + Buffer.from('test-key').toString('base64')
  const sign = (id: string, ts: string, body: string) =>
    'v1,' + createHmac('sha256', Buffer.from('test-key')).update(`${id}.${ts}.${body}`).digest('base64')

  it('verifies Svix signatures and rejects tampering or stale timestamps', () => {
    const body = '{"event_type":"intent.succeeded"}'
    const now = 1_800_000_000
    const h = { id: 'msg_1', timestamp: String(now), signature: `v1,bogus ${sign('msg_1', String(now), body)}` }
    expect(verifySvixSignature(body, h, secret, now)).toBe(true)
    expect(verifySvixSignature(body + ' ', h, secret, now)).toBe(false)
    expect(verifySvixSignature(body, h, secret, now + 600)).toBe(false)
    expect(verifySvixSignature(body, { ...h, id: null }, secret, now)).toBe(false)
  })

  it('reads the checkout back with the secret key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'paid', total_in_cents: 45800, currency: 'GTQ', metadata: { shopify_order_id: 'gid://shopify/DraftOrder/9' },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const c = await getRecurrenteCheckout('sk_test_1', 'ch_1')
    expect(c.metadata?.shopify_order_id).toBe('gid://shopify/DraftOrder/9')
    expect(fetchMock.mock.calls[0][0]).toBe('https://app.recurrente.com/api/checkouts/ch_1')
    expect(fetchMock.mock.calls[0][1].headers['X-SECRET-KEY']).toBe('sk_test_1')
  })

  const cfg = { shop: 'x.myshopify.com', token: 't' }
  const draft = (status: string, amount: string, currencyCode = 'GTQ') =>
    new Response(JSON.stringify({ data: { draftOrder: { status, totalPriceSet: { shopMoney: { amount, currencyCode } },
      lineItems: { nodes: [{ title: 'Lámpara', quantity: 2, variant: { id: 'gid://shopify/ProductVariant/1' } }] } } } }))
  const stock = (inventoryQuantity: number) => new Response(JSON.stringify({ data: { nodes: [
    { id: 'gid://shopify/ProductVariant/1', inventoryQuantity, inventoryPolicy: 'DENY', inventoryItem: { tracked: true } }] } }))
  const MISMATCH = { held: expect.stringContaining('importe/moneda') }

  it('completes an open draft as paid when the total matches and stock still covers it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(draft('OPEN', '458.00'))
      .mockResolvedValueOnce(stock(2))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { draftOrderComplete: { draftOrder: { order: { id: 'gid://shopify/Order/5', name: '#1005' } }, userErrors: [] } },
      })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await completePaidDraftOrder(cfg, 'gid://shopify/DraftOrder/9', 458, 'GTQ', true)).toEqual({ order: { id: 'gid://shopify/Order/5', name: '#1005' } })
    const mutation = JSON.parse(fetchMock.mock.calls[2][1].body).query as string
    expect(mutation).toContain('draftOrderComplete')
    expect(mutation).not.toContain('paymentPending')
  })

  it('skips completed drafts and amount mismatches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(draft('COMPLETED', '458.00')).mockResolvedValueOnce(draft('OPEN', '500.00')))
    expect(await completePaidDraftOrder(cfg, 'gid://shopify/DraftOrder/9', 458, 'GTQ', true)).toEqual(MISMATCH)
    expect(await completePaidDraftOrder(cfg, 'gid://shopify/DraftOrder/9', 458, 'GTQ', true)).toEqual(MISMATCH)
  })
  it('never completes a draft paid in another currency, even when the number matches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(draft('OPEN', '458.00', 'USD'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await completePaidDraftOrder(cfg, 'gid://shopify/DraftOrder/9', 458, 'GTQ', true)).toEqual(MISMATCH)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('holds a late payment for a purchase no longer open in the CRM, without completing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(draft('OPEN', '458.00'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await completePaidDraftOrder(cfg, 'gid://shopify/DraftOrder/9', 458, 'GTQ', false)).toEqual({ held: expect.stringContaining('ya no está abierta') })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('holds a payment when stock ran out after the link went out, without completing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draft('OPEN', '458.00')).mockResolvedValueOnce(stock(1))
    vi.stubGlobal('fetch', fetchMock)
    expect(await completePaidDraftOrder(cfg, 'gid://shopify/DraftOrder/9', 458, 'GTQ', true)).toEqual({ held: 'sin existencias al momento del pago: Lámpara' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('recovers the paid order on a retry after completion without completing it again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { draftOrder: {
      status: 'COMPLETED', totalPriceSet: { shopMoney: { amount: '458.00', currencyCode: 'GTQ' } },
      order: { id: 'gid://shopify/Order/5', name: '#1005', displayFinancialStatus: 'PAID' },
    } } })))
    vi.stubGlobal('fetch', fetchMock)
    // A retry finds the draft completed and its deal already moved: not "open" any more, still recovered.
    expect(await completePaidDraftOrder(cfg, 'gid://shopify/DraftOrder/9', 458, 'GTQ', false)).toEqual({ order: { id: 'gid://shopify/Order/5', name: '#1005' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('Dropi rejections written by Dropify', () => {
  it('recognises the tag regardless of spacing and case', () => {
    expect(hasDropiSyncError('por-confirmar, Dropi Sync Error')).toBe(true)
    expect(hasDropiSyncError('dropi sync error')).toBe(true)
    expect(hasDropiSyncError('por-confirmar')).toBe(false)
    expect(hasDropiSyncError(null)).toBe(false)
  })
  it('extracts the reason from the order note', () => {
    expect(dropiSyncReason(' - Nota Dropi: 3: La ciudad no existe. CIUDAD: X -- ')).toBe('La ciudad no existe. CIUDAD: X')
    expect(dropiSyncReason('Cliente pidió llamar antes')).toBe('')
  })
})

describe('payment method and delivery state', () => {
  it('treats only a cash-on-delivery gateway as COD', () => {
    expect(isCashOnDelivery(['Cash on Delivery (COD)'])).toBe(true)
    expect(isCashOnDelivery(['Pago contra entrega (COD)'])).toBe(true)
    expect(isCashOnDelivery(['Depósito bancario'])).toBe(false)
    expect(isCashOnDelivery(['Recurrente'])).toBe(false)
    expect(isCashOnDelivery(null)).toBe(false)
  })
  it('calls an order delivered only when every live package is and nothing is left to ship', () => {
    const delivered = { status: 'success', shipment_status: 'delivered' }
    expect(orderFullyDelivered([delivered], 'fulfilled')).toBe(true)
    expect(orderFullyDelivered([delivered], 'partial')).toBe(false)
    expect(orderFullyDelivered([delivered, { status: 'success', shipment_status: 'in_transit' }], 'fulfilled')).toBe(false)
    expect(orderFullyDelivered([delivered, { status: 'cancelled', shipment_status: null }], 'fulfilled')).toBe(true)
    expect(orderFullyDelivered([], 'fulfilled')).toBe(false)
  })
})

describe('order deal placement', () => {
  it('uses the dropshipping kit "Pedidos" board at "Pedido creado" even when an older pipeline exists', () => {
    expect(pickOrderPipeline([{ id: 'p1', name: 'Ventas' }, { id: 'p2', name: 'Pedidos' }])?.id).toBe('p2')
    expect(pickOrderStage([{ id: 's1', name: 'Consulta' }, { id: 's2', name: 'Pedido creado' }])?.id).toBe('s2')
  })
  it('falls back to the oldest pipeline and its first stage', () => {
    expect(pickOrderPipeline([{ id: 'p1', name: 'Ventas' }, { id: 'p2', name: 'Otro' }])?.id).toBe('p1')
    expect(pickOrderStage([{ id: 's1', name: 'Nuevo' }, { id: 's2', name: 'Ganado' }])?.id).toBe('s1')
    expect(pickOrderPipeline([])).toBeNull()
  })
})

describe('paid card order stage', () => {
  const stages = [
    { id: 's1', name: 'Consulta', position: 0 },
    { id: 's2', name: 'Pedido creado', position: 1 },
    { id: 's3', name: 'Pago confirmado', position: 2 },
    { id: 's4', name: 'Enviado', position: 3 },
  ]
  it('moves a placed order to "Pago confirmado"', () => {
    expect(pickPaidStage(stages, 's2')?.id).toBe('s3')
  })
  it('never moves a deal backwards or onto its own stage', () => {
    expect(pickPaidStage(stages, 's4')).toBeNull()
    expect(pickPaidStage(stages, 's3')).toBeNull()
  })
  it('leaves pipelines without that stage alone', () => {
    expect(pickPaidStage(stages.filter((s) => s.id !== 's3'), 's2')).toBeNull()
  })
})

describe('pickForwardStage (shipping updates)', () => {
  const stages = [
    { id: 's1', name: 'Consulta', position: 0 }, { id: 's2', name: 'Pedido creado', position: 1 },
    { id: 's3', name: 'Pago confirmado', position: 2 }, { id: 's4', name: 'Enviado', position: 3 },
    { id: 's5', name: 'Entregado', position: 4 },
  ]
  it('moves an order forward to Enviado / Entregado', () => {
    expect(pickForwardStage(stages, 's2', 'Enviado')?.id).toBe('s4')
    expect(pickForwardStage(stages, 's4', 'Entregado')?.id).toBe('s5')
  })
  it('returns null for a repeated or late update, so the customer is not told twice', () => {
    expect(pickForwardStage(stages, 's4', 'Enviado')).toBeNull()
    expect(pickForwardStage(stages, 's5', 'Enviado')).toBeNull()
  })
})

describe('trackingSentence', () => {
  it('gives the guide number, carrier and link when Dropi sent them', () => {
    expect(trackingSentence({ tracking_number: 'GT123', tracking_company: 'Cargo Expreso', tracking_url: 'https://t/GT123' }))
      .toBe('Número de guía: GT123 (Cargo Expreso). Rastreo: https://t/GT123')
  })
  it('never leaves the template parameter empty', () => {
    expect(trackingSentence({ tracking_number: null })).toBe('El mensajero le contactará antes de la entrega.')
  })
})

describe('loadOrderStatuses', () => {
  it('reports a draft as a registered order without a number, and a completed draft as its order (Casa Ceiba 2026-11-12)', async () => {
    const table = (t: string) => {
      const c: Record<string, unknown> = {
        select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c,
        maybeSingle: async () => ({ data: { shop_domain: 'x.myshopify.com', access_token: 'tok' } }),
        then: (ok: (v: unknown) => unknown) => ok({ data: t === 'deals' ? [{ shopify_order_id: 'gid://shopify/DraftOrder/3' }, { shopify_order_id: 'gid://shopify/DraftOrder/2' }] : [] }),
      }
      return c
    }
    const order = { id: 'gid://shopify/Order/9', name: '#1009', createdAt: '2026-11-12T00:00:00Z', cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', phone: null, shippingAddress: null, fulfillments: [] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { nodes: [
      { name: '#D3', createdAt: '2026-11-12T06:05:00Z', status: 'OPEN', tags: ['chat-sandia', CARD_TAG], order: null },
      { name: '#D2', createdAt: '2026-11-11T06:05:00Z', status: 'COMPLETED', order },
    ] } }))))
    const found = await loadOrderStatuses({ db: { from: table } as never, accountId: 'a', contactId: 'c', contactPhone: '', text: '¿cómo va mi pedido?' })
    expect(found.map((o) => o.name)).toEqual(['Pedido registrado (aún sin número de pedido)', '#1009'])
    expect(describeOrderStatuses(found)).toContain('PENDIENTE con tarjeta')
  })
})

describe('outOfStockTitles', () => {
  it('refuses to treat a missing variant as available stock', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { nodes: [null] } }))))
    await expect(outOfStockTitles({ shop: 'x.myshopify.com', token: 't' }, [
      { variantId: 'missing', quantity: 1, title: 'Producto' },
    ])).rejects.toThrow('No se pudo verificar el inventario')
  })
  it('flags only tracked, deny-oversell variants short of the quantity (Dropi stock synced by Dropify)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { nodes: [
      { id: 'a', inventoryQuantity: 0, inventoryPolicy: 'DENY', inventoryItem: { tracked: true } },
      { id: 'b', inventoryQuantity: 5, inventoryPolicy: 'DENY', inventoryItem: { tracked: true } },
      { id: 'c', inventoryQuantity: 0, inventoryPolicy: 'CONTINUE', inventoryItem: { tracked: true } },
      { id: 'd', inventoryQuantity: 1, inventoryPolicy: 'DENY', inventoryItem: { tracked: true } },
    ] } }))))
    const lines = [
      { variantId: '1', quantity: 1, title: 'Drone' }, { variantId: '2', quantity: 2, title: 'Freidora' },
      { variantId: '3', quantity: 1, title: 'Luces' }, { variantId: '4', quantity: 2, title: 'Proyector' },
    ]
    expect(await outOfStockTitles({ shop: 'x.myshopify.com', token: 't' }, lines)).toEqual(['Drone', 'Proyector'])
  })
})
