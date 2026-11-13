import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  deal: null as Record<string, unknown> | null,
  /** The duplicate check (`select('id')`) on deals; null = new order. */
  seen: null as Record<string, unknown> | null,
  stages: [] as Record<string, unknown>[],
  contact: { phone: '50254852732', name: 'Ángel Durán' } as Record<string, unknown> | null,
  updates: [] as { table: string; row: Record<string, unknown> }[],
  inWindow: false,
  send: vi.fn(async () => ({ messageId: 'm1' })),
  resolve: vi.fn(async () => ({ contactId: 'c1', conversationId: 'conv1' })),
  attach: vi.fn(async () => 'd1'),
}))

const STAGES = [
  { id: 's2', name: 'Pedido creado', position: 1 }, { id: 's3', name: 'Pago confirmado', position: 2 },
  { id: 's4', name: 'Enviado', position: 3 }, { id: 's5', name: 'Entregado', position: 4 },
]

function chain(table: string) {
  const rows: Record<string, unknown> = {
    shopify_config: { account_id: 'a1', user_id: 'u1', webhook_secret: 'k', client_secret: null, confirmation_template_name: 'pedido_recibido', confirmation_template_language: 'es' },
    deals: m.deal, contacts: m.contact,
  }
  let cols = ''
  const c: Record<string, unknown> = {
    select: (s: string) => { cols = s; return c }, eq: () => c,
    maybeSingle: async () => ({ data: table === 'deals' && cols === 'id' ? m.seen : rows[table] ?? null }),
    update: (row: Record<string, unknown>) => { m.updates.push({ table, row }); return c },
    then: (ok: (v: unknown) => unknown) => ok({ data: table === 'pipeline_stages' ? m.stages : null, error: null }),
  }
  return c
}

vi.mock('@/lib/webhooks/admin-client', () => ({ supabaseAdmin: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: m.resolve }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: m.send }))
vi.mock('@/lib/messaging/window', () => ({ isWithinMessagingWindow: async () => m.inWindow }))
vi.mock('@/lib/shopify/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/shopify/api')>()),
  verifyShopifyHmac: () => true,
  attachOrderToDeal: m.attach,
  loadShopifyConfig: async () => null,
}))

import { POST } from './route'

const hook = (topic: string, body: unknown) => POST(new Request('http://x/api/shopify/webhook', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'x-shopify-shop-domain': 'x0rkkg-b4.myshopify.com', 'x-shopify-hmac-sha256': 'sig', 'x-shopify-topic': topic },
}))

beforeEach(() => {
  m.deal = { id: 'd1', contact_id: 'c1', pipeline_id: 'p1', stage_id: 's2' }
  m.seen = null
  m.stages = STAGES
  m.updates = []
  m.inWindow = false
  m.send.mockClear()
})

describe('Shopify webhook — fulfillments (Dropify writes Dropi shipments back)', () => {
  it('moves the deal to Enviado and sends the shipped template outside the 24h window', async () => {
    await hook('fulfillments/create', { order_id: 77, name: '#1001.1', tracking_number: 'GT9', tracking_company: 'Forza' })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's4' } })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      messageType: 'template', templateName: 'pedido_enviado',
      templateParams: ['Ángel', '#1001', 'Número de guía: GT9 (Forza).'],
    }))
  })

  it('sends plain text with the guide inside the 24h window', async () => {
    m.inWindow = true
    await hook('fulfillments/create', { order_id: 77, name: '#1001.1', tracking_number: 'GT9' })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      messageType: 'text', contentText: '🚚 Su pedido #1001 ya va en camino. Número de guía: GT9.',
    }))
  })

  it('does not message twice when Shopify repeats the shipment', async () => {
    m.deal = { id: 'd1', contact_id: 'c1', pipeline_id: 'p1', stage_id: 's4' }
    await hook('fulfillments/create', { order_id: 77, name: '#1001.1' })
    expect(m.send).not.toHaveBeenCalled()
    expect(m.updates).toEqual([])
  })

  it('marks it delivered only when the carrier says so', async () => {
    m.deal = { id: 'd1', contact_id: 'c1', pipeline_id: 'p1', stage_id: 's4' }
    m.inWindow = true
    await hook('fulfillments/update', { order_id: 77, name: '#1001.1', shipment_status: 'in_transit' })
    expect(m.updates).toEqual([])
    await hook('fulfillments/update', { order_id: 77, name: '#1001.1', shipment_status: 'delivered' })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's5' } })
    expect(m.send).toHaveBeenCalledTimes(1)
  })
})

describe('Shopify webhook — web-store orders', () => {
  it('sends the order number with the approved template to a customer who never wrote', async () => {
    m.deal = null
    await hook('orders/create', {
      admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '300.00', currency: 'GTQ',
      shipping_address: { first_name: 'Ana', phone: '42883689' },
    })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      messageType: 'template', templateName: 'pedido_recibido', templateParams: ['Ana', '#1002', expect.stringContaining('300')],
    }))
  })

  it('asks a cash-on-delivery customer to confirm and parks the deal in "Por confirmar"', async () => {
    m.inWindow = true
    m.deal = { pipeline_id: 'p1' }
    m.stages = [{ id: 's1', name: 'Por confirmar', position: 1 }, ...STAGES]
    await hook('orders/create', {
      admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '300.00', currency: 'GTQ', financial_status: 'pending',
      line_items: [{ title: 'Retrovisor', quantity: 1 }],
      shipping_address: { first_name: 'Ana', phone: '42883689', address1: '4a calle 8-20', city: 'Mixco' },
    })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's1' } })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      messageType: 'text',
      contentText: expect.stringMatching(/#1002\*:\n• 1 x Retrovisor\nTotal: Q300, pago contra entrega\.\nEntrega en: 4a calle 8-20, Mixco\.[\s\S]*¿Confirma su pedido\? Responda \*SÍ\*/),
    }))
  })

  it('keeps the plain order-number message when the board has no "Por confirmar" stage', async () => {
    m.inWindow = true
    m.deal = { pipeline_id: 'p1' }
    await hook('orders/create', {
      admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '300.00', currency: 'GTQ', financial_status: 'pending',
      shipping_address: { first_name: 'Ana', phone: '42883689' },
    })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      contentText: expect.stringContaining('Ese es su número de pedido'),
    }))
  })

  it('skips orders the chat created itself', async () => {
    await hook('orders/create', { admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '1', currency: 'GTQ', tags: 'chat-sandia' })
    expect(m.send).not.toHaveBeenCalled()
  })
})

describe('Shopify webhook — orders/updated (the admin "Actualización de pedido" webhook)', () => {
  it('reads the shipment and guide from the order and moves it to Enviado', async () => {
    m.inWindow = true
    await hook('orders/updated', {
      admin_graphql_api_id: 'gid://shopify/Order/77', name: '#1001', total_price: '300', currency: 'GTQ',
      fulfillments: [{ status: 'success', tracking_number: 'GT9', shipment_status: null }],
    })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's4' } })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      contentText: '🚚 Su pedido #1001 ya va en camino. Número de guía: GT9.',
    }))
  })

  it('ignores ordinary order edits with nothing shipped', async () => {
    await hook('orders/updated', { admin_graphql_api_id: 'gid://shopify/Order/77', name: '#1001', fulfillments: [] })
    expect(m.updates).toEqual([])
    expect(m.send).not.toHaveBeenCalled()
  })

  it('marks it delivered when the carrier reports delivery', async () => {
    m.deal = { id: 'd1', contact_id: 'c1', pipeline_id: 'p1', stage_id: 's4' }
    m.inWindow = true
    await hook('orders/updated', {
      admin_graphql_api_id: 'gid://shopify/Order/77', name: '#1001',
      fulfillments: [{ status: 'success', tracking_number: 'GT9', shipment_status: 'delivered' }],
    })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's5' } })
  })
})
