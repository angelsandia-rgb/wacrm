import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  deal: null as Record<string, unknown> | null,
  /** The duplicate check (`select('id')`) on deals; null = new order. */
  seen: null as Record<string, unknown> | null,
  stages: [] as Record<string, unknown>[],
  /** message_templates rows Meta approved. */
  approved: [] as { name: string; language: string }[],
  contact: { phone: '50254852732', name: 'Ángel Durán' } as Record<string, unknown> | null,
  updates: [] as { table: string; row: Record<string, unknown> }[],
  inWindow: false,
  send: vi.fn(async () => ({ messageId: 'm1' })),
  resolve: vi.fn(async () => ({ contactId: 'c1', conversationId: 'conv1' })),
  attach: vi.fn(async () => 'd1'),
  jobs: new Map<string, { payload: import('@/lib/shopify/notification-jobs').OrderNotification; sent: boolean }>(),
  queueError: false,
  /** Live order read back by the fulfillments/* delivery check. */
  liveOrder: null as Record<string, unknown> | null,
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
    select: (s: string) => { cols = s; return c }, eq: () => c, in: () => c,
    maybeSingle: async () => ({ data: table === 'deals' && cols === 'id, stage_id, pipeline_id' ? m.seen : rows[table] ?? null }),
    update: (row: Record<string, unknown>) => { m.updates.push({ table, row }); return c },
    then: (ok: (v: unknown) => unknown) => ok({
      data: table === 'pipeline_stages' ? m.stages : table === 'message_templates' ? m.approved : null, error: null,
    }),
  }
  return c
}

vi.mock('@/lib/webhooks/admin-client', () => ({ supabaseAdmin: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: m.resolve }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: m.send }))
vi.mock('@/lib/messaging/window', () => ({ isWithinMessagingWindow: async () => m.inWindow }))
vi.mock('@/lib/shopify/notification-jobs', () => ({
  enqueueOrderNotification: async (_db: unknown, _account: string, key: string, payload: import('@/lib/shopify/notification-jobs').OrderNotification) => {
    if (m.queueError) throw new Error('queue unavailable')
    if (!m.jobs.has(key)) m.jobs.set(key, { payload, sent: false })
  },
  runOrderNotificationSweep: async (db: never, account: string, key: string) => {
    const job = m.jobs.get(key)
    if (!job || job.sent) return
    try {
      const { notifyCustomer } = await import('@/lib/shopify/notify')
      job.sent = await notifyCustomer(db, account, job.payload.conversationId, job.payload.text, job.payload.template)
    } catch { /* persisted for the next sweep */ }
  },
}))
vi.mock('@/lib/shopify/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/shopify/api')>()),
  verifyShopifyHmac: () => true,
  attachOrderToDeal: m.attach,
  loadShopifyConfig: async () => ({ shop: 's', token: 't' }),
  shopifyGraphql: async () => ({ order: m.liveOrder }),
  updateOrderTags: async () => {},
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
  m.approved = [{ name: 'pedido_enviado', language: 'es' }, { name: 'pedido_recibido', language: 'es' }]
  m.updates = []
  m.inWindow = false
  m.send.mockReset().mockResolvedValue({ messageId: 'm1' })
  m.attach.mockClear()
  m.jobs.clear()
  m.queueError = false
  m.liveOrder = null
})

describe('Shopify webhook — fulfillments (Dropify writes Dropi shipments back)', () => {
  it('does not advance the deal if its notification cannot be persisted', async () => {
    m.queueError = true
    const response = await hook('fulfillments/create', { order_id: 77, name: '#1001.1' })
    expect(response.status).toBe(500)
    expect(m.updates).toEqual([])
    expect(m.send).not.toHaveBeenCalled()
  })
  it('retains a failed shipping notification after moving the stage', async () => {
    m.send.mockRejectedValueOnce(new Error('WhatsApp unavailable'))
    await hook('fulfillments/create', { order_id: 77, name: '#1001.1' })
    expect(m.jobs.get('gid://shopify/Order/77:shipped')?.sent).toBe(false)
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's4' } })
  })
  it('moves the deal to Enviado and sends the shipped template outside the 24h window', async () => {
    await hook('fulfillments/create', { order_id: 77, name: '#1001.1', tracking_number: 'GT9', tracking_company: 'Forza' })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's4' } })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      messageType: 'template', templateName: 'pedido_enviado',
      templateParams: ['Ángel', '#1001', 'Número de guía: GT9 (Forza).'],
    }))
  })

  it('prefers the usted template pedido_en_camino once Meta approves it', async () => {
    m.approved = [{ name: 'pedido_enviado', language: 'es' }, { name: 'pedido_en_camino', language: 'es' }]
    await hook('fulfillments/create', { order_id: 77, name: '#1001.1', tracking_number: 'GT9' })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({ templateName: 'pedido_en_camino' }))
  })

  it('stays silent outside the window when no shipped template is approved', async () => {
    m.approved = []
    await hook('fulfillments/create', { order_id: 77, name: '#1001.1', tracking_number: 'GT9' })
    expect(m.send).not.toHaveBeenCalled()
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's4' } })
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
    m.liveOrder = { displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED' }] }
    await hook('fulfillments/update', { order_id: 77, name: '#1001.1', shipment_status: 'in_transit' })
    expect(m.updates).toEqual([])
    await hook('fulfillments/update', { order_id: 77, name: '#1001.1', shipment_status: 'delivered' })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's5' } })
    expect(m.send).toHaveBeenCalledTimes(1)
  })
})

describe('Shopify webhook — web-store orders', () => {
  it('asks Shopify to retry when its order deal could not be persisted', async () => {
    m.attach.mockRejectedValueOnce(new Error('Cannot create order deal: database unavailable'))
    const response = await hook('orders/create', {
      admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '300.00', currency: 'GTQ',
      shipping_address: { first_name: 'Ana', phone: '42883689' },
    })
    expect(response.status).toBe(500)
    expect(m.jobs.size).toBe(0)
    expect(m.send).not.toHaveBeenCalled()
  })
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
      admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '300.00', currency: 'GTQ', financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'],
      line_items: [{ title: 'Retrovisor', quantity: 1 }],
      shipping_address: { first_name: 'Ana', phone: '42883689', address1: '4a calle 8-20', city: 'Mixco' },
    })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's1' } })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      messageType: 'text',
      contentText: expect.stringMatching(/#1002\*:\n• 1 x Retrovisor\nTotal: Q300, pago contra entrega\.\nEntrega en: 4a calle 8-20, Mixco\.[\s\S]*¿Confirma su pedido\? Responda \*SÍ\*/),
    }))
  })

  it('asks a customer who never wrote to confirm with the confirmar_pedido template', async () => {
    m.deal = { pipeline_id: 'p1' }
    m.stages = [{ id: 's1', name: 'Por confirmar', position: 1 }, ...STAGES]
    m.approved = [{ name: 'confirmar_pedido', language: 'es' }]
    await hook('orders/create', {
      admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '300.00', currency: 'GTQ', financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'],
      shipping_address: { first_name: 'Ana', phone: '42883689' },
    })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      messageType: 'template', templateName: 'confirmar_pedido', templateParams: ['Ana', '#1002', 'Q300'],
    }))
  })

  it('keeps the plain order-number message when the board has no "Por confirmar" stage', async () => {
    m.inWindow = true
    m.deal = { pipeline_id: 'p1' }
    await hook('orders/create', {
      admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '300.00', currency: 'GTQ', financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'],
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
      fulfillment_status: 'fulfilled',
      fulfillments: [{ status: 'success', tracking_number: 'GT9', shipment_status: 'delivered' }],
    })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's5' } })
  })

  it('keeps a split order at Enviado while only one of its packages is delivered', async () => {
    m.deal = { id: 'd1', contact_id: 'c1', pipeline_id: 'p1', stage_id: 's2' }
    await hook('orders/updated', {
      admin_graphql_api_id: 'gid://shopify/Order/77', name: '#1001', fulfillment_status: 'partial',
      fulfillments: [{ status: 'success', tracking_number: 'GT9', shipment_status: 'delivered' }],
    })
    expect(m.updates).toContainEqual({ table: 'deals', row: { stage_id: 's4' } })
    expect(m.updates).not.toContainEqual({ table: 'deals', row: { stage_id: 's5' } })
  })

  it('closes the open deal as lost when the order is cancelled, without messaging the customer', async () => {
    await hook('orders/cancelled', { admin_graphql_api_id: 'gid://shopify/Order/77', name: '#1001', cancelled_at: '2026-11-13T10:00:00Z' })
    expect(m.updates).toContainEqual({ table: 'deals', row: expect.objectContaining({ status: 'lost', lost_reason: 'Pedido cancelado en Shopify' }) })
    expect(m.send).not.toHaveBeenCalled()
  })
})

describe('Shopify webhook — one delivered package of a split order', () => {
  it('does not mark the order delivered while another package is still on its way', async () => {
    m.deal = { id: 'd1', contact_id: 'c1', pipeline_id: 'p1', stage_id: 's4' }
    m.liveOrder = { displayFulfillmentStatus: 'FULFILLED', fulfillments: [
      { status: 'SUCCESS', displayStatus: 'DELIVERED' }, { status: 'SUCCESS', displayStatus: 'IN_TRANSIT' }] }
    await hook('fulfillments/update', { order_id: 77, name: '#1001.1', shipment_status: 'delivered' })
    expect(m.updates).toEqual([])
    expect(m.send).not.toHaveBeenCalled()
  })
})

describe('Shopify webhook — payment method of web orders', () => {
  it('does not ask a pending card/transfer buyer to confirm a cash-on-delivery order', async () => {
    m.inWindow = true
    m.deal = { pipeline_id: 'p1' }
    m.stages = [{ id: 's1', name: 'Por confirmar', position: 1 }, ...STAGES]
    await hook('orders/create', {
      admin_graphql_api_id: 'gid://shopify/Order/9', name: '#1002', total_price: '300.00', currency: 'GTQ',
      financial_status: 'pending', payment_gateway_names: ['Depósito bancario'],
      shipping_address: { first_name: 'Ana', phone: '42883689' },
    })
    expect(m.updates).not.toContainEqual({ table: 'deals', row: { stage_id: 's1' } })
    expect(m.send).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({
      contentText: expect.not.stringContaining('contra entrega'),
    }))
  })
})
