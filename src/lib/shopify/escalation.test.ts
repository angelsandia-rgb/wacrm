import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  jobs: [] as Record<string, unknown>[],
  unread: [] as { user_id: string }[],
  claimed: new Set<string>(),
  updates: [] as Record<string, unknown>[],
  email: vi.fn(),
  alert: vi.fn(async () => ({ opened: true, notified: true, alertId: 'x' })),
}))
vi.mock('@/lib/email/send', () => ({ sendEmail: m.email }))
vi.mock('@/lib/observability/alerts', () => ({ dispatchSystemAlert: m.alert }))

import { noticesToChase, runNoticeEscalation } from './escalation'

function db() {
  const from = (table: string) => {
    let upsertRow: Record<string, unknown> | null = null
    const c: Record<string, unknown> = {
      select: () => c, eq: () => c, not: () => c, gte: () => c, lte: () => c, in: () => c, is: () => c,
      update: (row: Record<string, unknown>) => { m.updates.push(row); return c },
      upsert: (row: Record<string, unknown>) => { upsertRow = row; return c },
      maybeSingle: async () => ({ data: table === 'accounts' ? { name: 'Casa Ceiba' } : null, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        if (upsertRow) {
          const key = String(upsertRow.event_key)
          const fresh = !m.claimed.has(key)
          m.claimed.add(key)
          return ok({ data: fresh ? [{ event_key: key }] : [], error: null })
        }
        if (table === 'notifications') return ok({ data: m.unread, error: null })
        return ok({ data: m.jobs, error: null })
      },
    }
    return c
  }
  return { from, auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@example.com` } }, error: null }) } } } as never
}

const now = new Date('2026-11-16T18:00:00Z')
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString()
const notice = (key: string, min: number) => ({
  account_id: 'a1', event_key: key, created_at: ago(min),
  payload: { staff: { userIds: ['owner'], ids: ['n1'], title: 'Pago de Q300 retenido', body: '💳 Se cobraron Q300…' } },
})

beforeEach(() => {
  m.jobs = []; m.unread = [{ user_id: 'owner' }]; m.claimed = new Set(); m.updates = []
  m.email.mockReset().mockResolvedValue(undefined); m.alert.mockClear()
})

describe('unread store notices are escalated by email', () => {
  it('only notices between 30 min and 24 h old, never the email claims themselves', () => {
    const jobs = [notice('fresh', 10), notice('due', 45), notice('old', 25 * 60), notice('due:email', 45)]
    expect(noticesToChase(jobs, now).map((j) => j.event_key)).toEqual(['due'])
  })

  it('emails each person who has not read it, once, however many runs see it', async () => {
    m.jobs = [notice('ch_1:payment-held', 45)]
    expect(await runNoticeEscalation(db(), now)).toEqual({ emailed: 1, failed: 0 })
    expect(m.email).toHaveBeenCalledWith(expect.objectContaining({
      to: 'owner@example.com', subject: 'Casa Ceiba: Pago de Q300 retenido', text: expect.stringContaining('chatsandia.com/notifications'),
    }))
    await runNoticeEscalation(db(), now)
    expect(m.email).toHaveBeenCalledTimes(1)
  })

  it('a notice already read in the app is not emailed', async () => {
    m.jobs = [notice('ch_1:payment-held', 45)]
    m.unread = []
    expect(await runNoticeEscalation(db(), now)).toEqual({ emailed: 0, failed: 0 })
    expect(m.email).not.toHaveBeenCalled()
  })

  it('an email that cannot be sent is recorded and alerted, never silent', async () => {
    m.jobs = [notice('ch_1:payment-held', 45)]
    m.email.mockRejectedValue(new Error('SMTP down'))
    expect(await runNoticeEscalation(db(), now)).toEqual({ emailed: 0, failed: 1 })
    expect(m.updates).toEqual([expect.objectContaining({ status: 'skipped', last_error: expect.stringContaining('SMTP down') })])
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ source: 'store_notice_email', accountId: 'a1' }))
  })
})
