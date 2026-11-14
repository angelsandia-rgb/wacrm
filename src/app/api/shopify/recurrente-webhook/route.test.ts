import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  cfg: null as Record<string, unknown> | null,
  checkout: { status: 'paid', total_in_cents: 30000, currency: 'GTQ', metadata: { shopify_order_id: 'gid://shopify/DraftOrder/1' } } as Record<string, unknown>,
  complete: vi.fn(),
  alert: vi.fn(async () => ({ opened: true, notified: true, alertId: 'x' })),
  updates: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/webhooks/admin-client', () => ({ supabaseAdmin: () => ({ from: () => {
  const c: Record<string, unknown> = {
    select: () => c, eq: () => c, in: () => c,
    maybeSingle: async () => ({ data: null, error: null }),
    update: (row: Record<string, unknown>) => { m.updates.push(row); return c },
  }
  return c
} }) }))
vi.mock('@/lib/observability/alerts', () => ({ dispatchSystemAlert: m.alert }))
vi.mock('@/lib/shopify/notification-jobs', () => ({ enqueueOrderNotification: vi.fn(), runOrderNotificationSweep: vi.fn() }))
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
  m.complete.mockReset().mockResolvedValue({ id: 'gid://shopify/Order/5', name: '#1005' })
  m.alert.mockClear()
  m.updates = []
})

describe('Recurrente payments', () => {
  it('holds a late payment with a critical alert while sales are paused, releasing nothing', async () => {
    m.cfg!.ordersLive = false
    const res = await paid()
    expect(await res.json()).toMatchObject({ held: expect.stringContaining('pausada') })
    expect(m.complete).not.toHaveBeenCalled()
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical', dedupKey: `shopify_payment_held:${ACCOUNT}:ch_1` }))
  })
  it('holds a payment whose draft total or currency does not match', async () => {
    m.complete.mockResolvedValue(null)
    await paid()
    expect(m.complete).toHaveBeenCalledWith(expect.anything(), 'gid://shopify/DraftOrder/1', 300, 'GTQ')
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('importe/moneda') }))
    expect(m.updates).toEqual([])
  })
  it('completes the draft as paid for the exact amount and currency read back from Recurrente', async () => {
    const res = await paid()
    expect(res.status).toBe(200)
    expect(m.complete).toHaveBeenCalledWith(expect.anything(), 'gid://shopify/DraftOrder/1', 300, 'GTQ')
    expect(m.alert).not.toHaveBeenCalled()
  })
  it('ignores a checkout that Recurrente does not report as paid', async () => {
    m.checkout = { ...m.checkout, status: 'payment_in_progress' }
    await paid()
    expect(m.complete).not.toHaveBeenCalled()
    expect(m.alert).not.toHaveBeenCalled()
  })
})
