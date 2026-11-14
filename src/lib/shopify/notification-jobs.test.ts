import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderNotification } from './notification-jobs'
import type { AbandonedCheckout } from './abandoned-cart-data'

const m = vi.hoisted(() => ({
  notify: vi.fn(), tags: [] as string[], muted: false, inbound: false, decision: null as string | null,
  cart: null as AbandonedCheckout | null,
  updateTags: vi.fn(),
  dealExists: true, dealStatus: 'open', stageName: 'Por confirmar',
}))
vi.mock('./notify', () => ({ notifyCustomer: m.notify }))
vi.mock('@/lib/ai/muted-contact', () => ({ contactMutesAi: async () => m.muted }))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  CANCEL_REQUESTED_TAG: 'cliente-cancela', CONFIRMED_TAG: 'confirmado-whatsapp',
  loadShopifyConfig: async () => ({}),
  shopifyGraphql: async () => ({ order: { tags: m.tags, cancelledAt: null }, node: m.cart }),
  updateOrderTags: m.updateTags,
}))
import { enqueueOrderNotification, runOrderNotificationSweep } from './notification-jobs'

function database() {
  const jobs = new Map<string, Record<string, unknown>>()
  const notifications = new Map<string, unknown>()
  let failSave = false
  let lostLease = false
  let expiredLease = false
  const db = {
    from(table: string) {
      let update: Record<string, unknown> | null = null
      const filters: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      const c = {
        select: () => c, limit: () => c,
        gt: (key: string, value: unknown) => { after[key] = value; return c },
        maybeSingle: async () => {
          if (table === 'shopify_notification_jobs') {
            if (failSave) return { data: null, error: { message: 'db unavailable' } }
            const row = [...jobs.values()].find(r => Object.entries(filters).every(([key, value]) => r[key] === value)
              && Object.entries(after).every(([key, value]) => String(r[key]) > String(value)))
            if (row) Object.assign(row, update)
            return { data: row ?? null, error: null }
          }
          return { data: table === 'deals'
          ? m.dealExists ? { shopify_confirmation_decision: m.decision, status: m.dealStatus, stage_id: 'pending' } : null
          : table === 'pipeline_stages' ? { name: m.stageName } : null, error: null }
        },
        eq: (key: string, value: unknown) => { filters[key] = value; return c },
        update: (value: Record<string, unknown>) => { update = value; return c },
        upsert: async (value: Record<string, unknown> | Record<string, unknown>[]) => {
          if (table === 'notifications') {
            for (const row of value as Record<string, unknown>[]) notifications.set(row.id as string, row)
          } else {
            const row = value as Record<string, unknown>
            const key = `${row.account_id}:${row.event_key}`
            if (!jobs.has(key)) jobs.set(key, { ...row, status: 'pending', attempts: 0 })
          }
          return { error: null }
        },
        then(resolve: (v: unknown) => unknown) {
          if (table === 'messages') return resolve({ data: m.inbound ? [{ id: 'm' }] : [], error: null })
          if (failSave) return resolve({ error: { message: 'db unavailable' } })
          for (const row of jobs.values()) {
            if (Object.entries(filters).every(([k, v]) => row[k] === v)) Object.assign(row, update)
          }
          return resolve({ error: null })
        },
      }
      return c
    },
    rpc: async (_name: string, params: { p_account_id: string | null; p_event_key: string | null }) => {
      const rows = [...jobs.values()].filter((r) => r.status === 'pending' &&
        (!params.p_account_id || r.account_id === params.p_account_id) && (!params.p_event_key || r.event_key === params.p_event_key))
      for (const row of rows) Object.assign(row, { status: 'processing', lease_token: 'lease', next_attempt_at: new Date(Date.now() + 10 * 60_000).toISOString(), attempts: Number(row.attempts) + 1 })
      const claimed = rows.map(r => ({ ...r }))
      if (lostLease) rows.forEach(row => { row.lease_token = 'new-owner' })
      if (expiredLease) rows.forEach(row => { row.next_attempt_at = new Date(Date.now() - 1).toISOString() })
      return { data: claimed, error: null }
    },
  }
  return { db: db as never, jobs, notifications, failSaves: () => { failSave = true },
    loseLease: () => { lostLease = true }, expireLease: () => { expiredLease = true } }
}
const payload: OrderNotification = { conversationId: 'c', text: 'Pedido enviado', template: null }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T16:00:00Z'))
  m.notify.mockReset().mockResolvedValue(true)
  m.updateTags.mockReset().mockResolvedValue(undefined)
  m.dealExists = true; m.dealStatus = 'open'; m.stageName = 'Por confirmar'
  m.tags = []; m.inbound = false; m.muted = false; m.decision = null
  m.cart = {
    id: 'cart', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), completedAt: null,
    abandonedCheckoutUrl: 'https://store/checkouts/recover', customer: null,
    shippingAddress: { firstName: 'Ana', phone: '54852732' },
    totalPriceSet: { shopMoney: { amount: '300.00', currencyCode: 'GTQ' } },
    lineItems: { nodes: [{ title: 'Producto', quantity: 1 }] },
  }
})
afterEach(() => { vi.useRealTimers() })

describe('durable Shopify notification delivery', () => {
  it.each(['confirm', 'cancel'] as const)('recovers %s tags after a provider outage without sending a second customer message', async (decision) => {
    const { db, jobs } = database()
    await enqueueOrderNotification(db, 'a', 'o:decision', { ...payload, decision: { orderId: 'o', decision } })
    m.updateTags.mockRejectedValueOnce(new Error('Shopify unavailable'))
    expect((await runOrderNotificationSweep(db)).pending).toBe(1)
    expect(jobs.get('a:o:decision')?.last_error).toBe('Shopify unavailable')
    expect((await runOrderNotificationSweep(db)).sent).toBe(1)
    await runOrderNotificationSweep(db)
    expect(m.updateTags).toHaveBeenCalledTimes(2)
    expect(m.updateTags).toHaveBeenLastCalledWith({}, 'o', [decision === 'confirm' ? 'confirmado-whatsapp' : 'cliente-cancela'], ['por-confirmar'])
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('retries an unavailable template, keeps the original payload and does not resend success', async () => {
    const { db, jobs } = database()
    await enqueueOrderNotification(db, 'a', 'order:shipped', payload)
    m.notify.mockResolvedValueOnce(false)
    expect(await runOrderNotificationSweep(db)).toEqual({ sent: 0, pending: 1, skipped: 0 })
    await enqueueOrderNotification(db, 'a', 'order:shipped', { ...payload, text: 'replacement' })
    expect(await runOrderNotificationSweep(db)).toEqual({ sent: 1, pending: 0, skipped: 0 })
    await runOrderNotificationSweep(db)
    expect(m.notify).toHaveBeenCalledTimes(2)
    expect(jobs.get('a:order:shipped')?.payload).toEqual(payload)
  })
  it('retains transport failures for retry', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'order:created', payload)
    m.notify.mockRejectedValueOnce(new Error('WhatsApp unavailable'))
    expect((await runOrderNotificationSweep(db)).pending).toBe(1)
    expect((await runOrderNotificationSweep(db)).sent).toBe(1)
  })
  it('uses a claim so concurrent workers only send once, scoped to the requested account', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'order:created', payload)
    await enqueueOrderNotification(db, 'b', 'order:created', payload)
    await Promise.all([runOrderNotificationSweep(db, 'a'), runOrderNotificationSweep(db, 'a')])
    expect(m.notify).toHaveBeenCalledTimes(1)
    expect(m.notify).toHaveBeenCalledWith(db, 'a', 'c', payload.text, null)
    await runOrderNotificationSweep(db, 'b')
    expect(m.notify).toHaveBeenCalledTimes(2)
  })
  it.each(['cliente-cancela', 'confirmado-whatsapp'])('drops a queued reminder after %s', async (tag) => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'order:reminder', {
      ...payload, confirmation: { orderId: 'o', contactId: 'ct', since: new Date().toISOString(), reminder: true },
    })
    m.tags = [tag]
    expect((await runOrderNotificationSweep(db)).skipped).toBe(1)
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('drops a reminder if the customer replied while the template was pending', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'order:reminder', {
      ...payload, confirmation: { orderId: 'o', contactId: 'ct', since: new Date().toISOString(), reminder: true },
    })
    m.inbound = true
    expect((await runOrderNotificationSweep(db)).skipped).toBe(1)
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('honors the saved cancellation even when Shopify still has no cancellation tag', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'order:reminder', {
      ...payload, confirmation: { orderId: 'o', contactId: 'ct', since: new Date().toISOString(), reminder: true },
    })
    m.decision = 'cancel'
    expect((await runOrderNotificationSweep(db)).skipped).toBe(1)
    expect(m.notify).not.toHaveBeenCalled()
  })
  it.each(['deleted', 'closed', 'advanced'])('discards a queued confirmation after its deal was %s', async (change) => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'order:reminder', {
      ...payload, confirmation: { orderId: 'o', contactId: 'ct', since: new Date().toISOString(), reminder: true },
    })
    if (change === 'deleted') m.dealExists = false
    if (change === 'closed') m.dealStatus = 'lost'
    if (change === 'advanced') m.stageName = 'Enviado'
    expect((await runOrderNotificationSweep(db)).skipped).toBe(1)
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('surfaces persistence failures rather than reporting a healthy sweep', async () => {
    const { db, failSaves } = database()
    await enqueueOrderNotification(db, 'a', 'order:created', payload)
    failSaves()
    await expect(runOrderNotificationSweep(db)).rejects.toThrow('Cannot renew notification lease')
  })
  it('surfaces a result-write failure after provider acceptance', async () => {
    const { db, failSaves } = database()
    await enqueueOrderNotification(db, 'a', 'order:created', payload)
    m.notify.mockImplementationOnce(async () => { failSaves(); return true })
    await expect(runOrderNotificationSweep(db)).rejects.toThrow('Cannot save notification result')
  })
  it.each(['expired', 'reclaimed'])('does not send using a lease which was %s before this batch item', async state => {
    const { db, loseLease, expireLease } = database()
    await enqueueOrderNotification(db, 'a', 'order:created', payload)
    if (state === 'expired') expireLease()
    else loseLease()
    await runOrderNotificationSweep(db)
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('persists stable staff notification IDs for idempotent insert retries', async () => {
    const { db, jobs, notifications } = database()
    await enqueueOrderNotification(db, 'a', 'order:unconfirmed', {
      ...payload, staff: { userIds: ['u1', 'u2'], title: 'Confirmar pedido', body: 'Llame al cliente' },
    })
    await runOrderNotificationSweep(db)
    jobs.get('a:order:unconfirmed')!.status = 'pending' // simulate crash after insertion, before marking success
    await runOrderNotificationSweep(db)
    expect(notifications.size).toBe(2)
    expect(m.notify).not.toHaveBeenCalled()
  })
})

describe('abandoned cart recovery in the same durable queue', () => {
  const cartJob: OrderNotification = { ...payload, cart: { checkoutId: 'cart', contactId: 'ct', phone: '+50254852732', storeName: 'Casa Ceiba' } }
  it('retries a pending template then sends the current cart once', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'cart:cart', cartJob)
    m.notify.mockResolvedValueOnce(false)
    expect((await runOrderNotificationSweep(db)).pending).toBe(1)
    m.cart!.lineItems.nodes = [{ title: 'Producto actualizado', quantity: 2 }]
    expect((await runOrderNotificationSweep(db)).sent).toBe(1)
    expect(m.notify).toHaveBeenLastCalledWith(db, 'a', 'c', expect.stringContaining('2 x Producto actualizado'), {
      names: ['carrito_abandonado'], params: ['Ana', '2 x Producto actualizado', 'https://store/checkouts/recover'],
    })
    await runOrderNotificationSweep(db)
    expect(m.notify).toHaveBeenCalledTimes(2)
  })
  it('does not remind a cart completed while delivery was pending', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'cart:cart', cartJob)
    m.notify.mockResolvedValueOnce(false)
    await runOrderNotificationSweep(db)
    m.cart!.completedAt = new Date().toISOString()
    expect((await runOrderNotificationSweep(db)).skipped).toBe(1)
    expect(m.notify).toHaveBeenCalledTimes(1)
  })
  it('does not send the previous customer’s cart after its phone changes', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'cart:cart', cartJob)
    m.cart!.shippingAddress!.phone = '55555555'
    expect((await runOrderNotificationSweep(db)).skipped).toBe(1)
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('drops carts older than 24 hours', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'cart:cart', cartJob)
    m.cart!.updatedAt = new Date(Date.now() - 25 * 3600_000).toISOString()
    expect((await runOrderNotificationSweep(db)).skipped).toBe(1)
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('waits again if the customer just edited the cart', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'cart:cart', cartJob)
    m.cart!.updatedAt = new Date().toISOString()
    expect((await runOrderNotificationSweep(db)).pending).toBe(1)
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('waits for business hours on retries', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'cart:cart', cartJob)
    vi.setSystemTime(new Date('2026-11-13T03:00:00Z'))
    m.cart!.updatedAt = new Date(Date.now() - 2 * 3600_000).toISOString()
    expect((await runOrderNotificationSweep(db)).pending).toBe(1)
    vi.setSystemTime(new Date('2026-11-13T14:00:00Z'))
    expect((await runOrderNotificationSweep(db)).sent).toBe(1)
    expect(m.notify).toHaveBeenCalledTimes(1)
  })
  it('respects contacts marked without AI', async () => {
    const { db } = database()
    await enqueueOrderNotification(db, 'a', 'cart:cart', cartJob)
    m.muted = true
    expect((await runOrderNotificationSweep(db)).skipped).toBe(1)
    expect(m.notify).not.toHaveBeenCalled()
  })
})
