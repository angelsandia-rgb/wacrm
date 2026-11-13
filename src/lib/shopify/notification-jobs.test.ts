import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderNotification } from './notification-jobs'

const m = vi.hoisted(() => ({
  notify: vi.fn(), tags: [] as string[], muted: false, inbound: false, decision: null as string | null,
}))
vi.mock('./notify', () => ({ notifyCustomer: m.notify }))
vi.mock('@/lib/ai/muted-contact', () => ({ contactMutesAi: async () => m.muted }))
vi.mock('./api', () => ({
  CANCEL_REQUESTED_TAG: 'cliente-cancela', CONFIRMED_TAG: 'confirmado-whatsapp',
  loadShopifyConfig: async () => ({}),
  shopifyGraphql: async () => ({ order: { tags: m.tags, cancelledAt: null } }),
}))
import { enqueueOrderNotification, runOrderNotificationSweep } from './notification-jobs'

function database() {
  const jobs = new Map<string, Record<string, unknown>>()
  const notifications = new Map<string, unknown>()
  let failSave = false
  const db = {
    from(table: string) {
      let update: Record<string, unknown> | null = null
      const filters: Record<string, unknown> = {}
      const c = {
        select: () => c, limit: () => c, gt: () => c,
        maybeSingle: async () => ({ data: table === 'deals' ? { shopify_confirmation_decision: m.decision } : null, error: null }),
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
      for (const row of rows) Object.assign(row, { status: 'processing', lease_token: 'lease', attempts: Number(row.attempts) + 1 })
      return { data: rows.map((r) => ({ ...r })), error: null }
    },
  }
  return { db: db as never, jobs, notifications, failSaves: () => { failSave = true } }
}
const payload: OrderNotification = { conversationId: 'c', text: 'Pedido enviado', template: null }
beforeEach(() => {
  m.notify.mockReset().mockResolvedValue(true)
  m.tags = []; m.inbound = false; m.muted = false; m.decision = null
})

describe('durable Shopify notification delivery', () => {
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
  it('surfaces persistence failures rather than reporting a healthy sweep', async () => {
    const { db, failSaves } = database()
    await enqueueOrderNotification(db, 'a', 'order:created', payload)
    failSaves()
    await expect(runOrderNotificationSweep(db)).rejects.toThrow('Cannot save notification result')
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
