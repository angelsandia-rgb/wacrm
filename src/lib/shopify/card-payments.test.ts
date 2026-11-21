import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  updates: [] as { checkout: unknown; row: Record<string, unknown> }[],
  upserts: [] as Record<string, unknown>[],
  upsertError: null as { message: string } | null,
  status: 'unpaid' as string,
  getCheckout: vi.fn(),
  complete: vi.fn(),
  alert: vi.fn(async () => ({ opened: true, notified: true, alertId: 'x' })),
}))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  loadShopifyConfig: async () => ({ shop: 's', token: 't', ordersLive: true, recurrenteSecretKey: 'sk_live_x' }),
  getRecurrenteCheckout: m.getCheckout,
  completePaidDraftOrder: m.complete,
}))
vi.mock('@/lib/observability/alerts', () => ({ dispatchSystemAlert: m.alert }))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: async () => ({ conversationId: 'c1' }) }))
vi.mock('./notification-jobs', () => ({ enqueueOrderNotification: vi.fn(), runOrderNotificationSweep: vi.fn() }))

import { dueCardCheckouts, recordCardCheckout, runCardCheckoutReconciliation } from './card-payments'

function db() {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    let patch: Record<string, unknown> | null = null
    const c: Record<string, unknown> = {
      select: () => c, order: () => c, limit: () => c, in: () => c,
      eq: (k: string, v: unknown) => { filters[k] = v; return c },
      update: (row: Record<string, unknown>) => { patch = row; return c },
      upsert: async (row: Record<string, unknown>) => { m.upserts.push(row); return { error: m.upsertError } },
      maybeSingle: async () => ({ data: table === 'deals' ? { id: 'd1', status: 'open', contact_id: null } : null, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        if (patch) { m.updates.push({ checkout: filters.checkout_id, row: patch }); return ok({ error: null }) }
        return ok({ data: table === 'shopify_card_checkouts' ? m.rows : [], error: null })
      },
    }
    return c
  }
  return { from } as never
}

const now = new Date('2026-11-16T18:00:00Z')
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString()

beforeEach(() => {
  m.rows = []; m.updates = []; m.upserts = []; m.upsertError = null
  m.getCheckout.mockReset().mockImplementation(async () => ({
    status: m.status, total_in_cents: 30000, currency: 'GTQ', metadata: { shopify_order_id: 'gid://shopify/DraftOrder/1' },
  }))
  m.complete.mockReset().mockResolvedValue({ order: { id: 'gid://shopify/Order/9', name: '#1009' } })
  m.alert.mockClear()
})

describe('card payment links are reconciled without their webhook', () => {
  it('only links of the last 7 days, not checked in the last 30 min', () => {
    const rows = [
      { id: 'new', created_at: ago(10), last_checked_at: null },
      { id: 'recent-check', created_at: ago(120), last_checked_at: ago(5) },
      { id: 'due', created_at: ago(120), last_checked_at: ago(45) },
      { id: 'old', created_at: ago(8 * 24 * 60), last_checked_at: null },
    ]
    expect(dueCardCheckouts(rows, now).map((r) => r.id)).toEqual(['new', 'due'])
  })

  it('a paid link whose webhook never came is completed as a paid order and closed', async () => {
    m.status = 'paid'
    m.rows = [{ account_id: 'a1', checkout_id: 'ch_1', created_at: ago(60), last_checked_at: null }]
    expect(await runCardCheckoutReconciliation(db(), now)).toMatchObject({ checked: 1, completed: 1, failed: 0 })
    expect(m.complete).toHaveBeenCalledWith(expect.anything(), 'gid://shopify/DraftOrder/1', 300, 'GTQ', true)
    expect(m.updates.at(-1)).toMatchObject({ checkout: 'ch_1', row: { status: 'completed', order_id: 'gid://shopify/Order/9' } })
  })

  it('a paid link that cannot be released is held for a person, never dropped', async () => {
    m.status = 'paid'
    m.complete.mockResolvedValue({ held: 'sin existencias al momento del pago: Sofá' })
    m.rows = [{ account_id: 'a1', checkout_id: 'ch_1', created_at: ago(60), last_checked_at: null }]
    expect(await runCardCheckoutReconciliation(db(), now)).toMatchObject({ held: 1 })
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical', source: 'shopify_payment_held' }))
    expect(m.updates.at(-1)).toMatchObject({ row: { status: 'held', note: expect.stringContaining('sin existencias') } })
  })

  it('an expired link is closed; an unpaid one only records the check', async () => {
    m.rows = [{ account_id: 'a1', checkout_id: 'ch_1', created_at: ago(60), last_checked_at: null }]
    m.status = 'expired'
    await runCardCheckoutReconciliation(db(), now)
    expect(m.updates.at(-1)).toMatchObject({ row: { status: 'expired' } })
    m.status = 'unpaid'
    await runCardCheckoutReconciliation(db(), now)
    expect(m.updates.at(-1)?.row).not.toHaveProperty('status')
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('Recurrente unavailable: counted and alerted, the link stays open for the next run', async () => {
    m.getCheckout.mockRejectedValue(new Error('Recurrente: HTTP 503'))
    m.rows = [{ account_id: 'a1', checkout_id: 'ch_1', created_at: ago(60), last_checked_at: null }]
    expect(await runCardCheckoutReconciliation(db(), now)).toMatchObject({ failed: 1 })
    expect(m.updates).toEqual([])
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ source: 'shopify_card_checkout' }))
  })

  it('a link that could not be recorded raises a critical alert', async () => {
    m.upsertError = { message: 'db down' }
    await recordCardCheckout(db(), 'a1', { checkoutId: 'ch_1', draftId: 'gid://shopify/DraftOrder/1', conversationId: null, amount: 300, currency: 'GTQ' })
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical', source: 'shopify_card_checkout' }))
  })
})
