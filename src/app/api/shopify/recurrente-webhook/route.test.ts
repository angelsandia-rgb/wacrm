import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  cfg: null as Record<string, unknown> | null,
  checkout: { status: 'paid', total_in_cents: 30000, currency: 'GTQ', metadata: { shopify_order_id: 'gid://shopify/DraftOrder/1' } } as Record<string, unknown>,
  complete: vi.fn(),
  alert: vi.fn(async () => ({ opened: true, notified: true, alertId: 'x' })),
  updates: [] as Record<string, unknown>[],
  /** The deal the draft belongs to (status read before releasing anything). */
  draftDeal: { id: 'd1', status: 'open', contact_id: 'ct1' } as Record<string, unknown> | null,
  enqueue: vi.fn(),
}))

vi.mock('@/lib/webhooks/admin-client', () => ({ supabaseAdmin: () => ({ from: () => {
  let cols = ''
  const c: Record<string, unknown> = {
    select: (s: string) => { cols = s; return c }, eq: () => c, in: () => c,
    maybeSingle: async () => ({ data: cols === 'id, status, contact_id' ? m.draftDeal : cols === 'phone, name' ? { phone: '54852732', name: 'Ana' } : null, error: null }),
    then: (ok: (v: unknown) => unknown) => ok({ data: [{ user_id: 'owner1' }], error: null }),
    update: (row: Record<string, unknown>) => { m.updates.push(row); return c },
  }
  return c
} }) }))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: async () => ({ conversationId: 'conv1' }) }))
vi.mock('@/lib/observability/alerts', () => ({ dispatchSystemAlert: m.alert }))
vi.mock('@/lib/shopify/notification-jobs', () => ({ enqueueOrderNotification: m.enqueue, runOrderNotificationSweep: vi.fn() }))
vi.mock('@/lib/shopify/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/shopify/api')>()),
  loadShopifyConfig: async () => m.cfg,
  verifySvixSignature: () => true,
  getRecurrenteCheckout: async () => m.checkout,
  completePaidDraftOrder: m.complete,
}))

import { POST } from './route'

const ACCOUNT = 'c14721dc-8895-434f-b041-64fa654e249a'
const paid = () => POST(new Request(`http://x/api/shopify/recurrente-webhook?account=${ACCOUNT}`, {
  method: 'POST', body: JSON.stringify({ event_type: 'payment_intent.succeeded', checkout: { id: 'ch_1' } }),
  headers: { 'svix-id': 'i', 'svix-timestamp': '1', 'svix-signature': 'v1,x' },
}))

beforeEach(() => {
  m.cfg = { ordersLive: true, recurrenteSecretKey: 'sk', recurrenteWebhookSecret: 'whsec_x' }
  m.complete.mockReset().mockResolvedValue({ order: { id: 'gid://shopify/Order/5', name: '#1005' } })
  m.alert.mockClear()
  m.enqueue.mockReset()
  m.draftDeal = { id: 'd1', status: 'open', contact_id: 'ct1' }
  m.updates = []
})

describe('Recurrente payments', () => {
  it('holds a late payment with a critical alert while sales are paused, releasing nothing', async () => {
    m.cfg!.ordersLive = false
    const res = await paid()
    expect(await res.json()).toMatchObject({ held: expect.stringContaining('pausada') })
    expect(m.complete).not.toHaveBeenCalled()
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical', dedupKey: `shopify_payment_held:${ACCOUNT}:ch_1` }))
    // The owner gets a stored notice, not only the platform alert.
    expect(m.enqueue).toHaveBeenCalledWith(expect.anything(), ACCOUNT, 'ch_1:payment-held', expect.objectContaining({
      conversationId: 'conv1', staff: expect.objectContaining({ userIds: ['owner1'], title: 'Pago de Q300 retenido' }),
    }))
  })
  it('answers 500 (Recurrente retries) when the owner notice cannot be stored', async () => {
    m.cfg!.ordersLive = false
    m.enqueue.mockRejectedValue(new Error('db down'))
    expect((await paid()).status).toBe(500)
  })
  it('tells the draft whether its purchase is still open in the CRM', async () => {
    m.draftDeal = { id: 'd1', status: 'lost', contact_id: 'ct1' }
    m.complete.mockResolvedValue({ held: 'la compra ya no está abierta en el CRM' })
    expect(await (await paid()).json()).toMatchObject({ held: expect.stringContaining('ya no está abierta') })
    expect(m.complete).toHaveBeenCalledWith(expect.anything(), 'gid://shopify/DraftOrder/1', 300, 'GTQ', false)
    expect(m.enqueue).toHaveBeenCalledWith(expect.anything(), ACCOUNT, 'ch_1:payment-held', expect.anything())
    expect(m.updates).toEqual([])
  })
  it('holds a payment whose draft total or currency does not match', async () => {
    m.complete.mockResolvedValue({ held: 'el borrador no existe o su importe/moneda no coincide con lo cobrado' })
    await paid()
    expect(m.complete).toHaveBeenCalledWith(expect.anything(), 'gid://shopify/DraftOrder/1', 300, 'GTQ', true)
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('importe/moneda') }))
    expect(m.updates).toEqual([])
  })
  it('completes the draft as paid for the exact amount and currency read back from Recurrente', async () => {
    const res = await paid()
    expect(res.status).toBe(200)
    expect(m.complete).toHaveBeenCalledWith(expect.anything(), 'gid://shopify/DraftOrder/1', 300, 'GTQ', true)
    expect(m.alert).not.toHaveBeenCalled()
  })
  it('ignores a checkout that Recurrente does not report as paid', async () => {
    m.checkout = { ...m.checkout, status: 'payment_in_progress' }
    await paid()
    expect(m.complete).not.toHaveBeenCalled()
    expect(m.alert).not.toHaveBeenCalled()
  })
})
