import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  convs: [] as Record<string, unknown>[],
  msgs: [] as Record<string, unknown>[],
  tags: [] as string[],
  done: [] as { stage: string }[],
  online: [] as string[],
  everyone: ['owner1', 'agent1', 'agent2'],
  loads: new Map<string, number>(),
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  claimFails: false,
  muted: false,
  inWindow: true,
  sent: vi.fn(async () => ({ messageId: 'm1' })),
}))

function chain(table: string) {
  let pendingInsert: unknown = null
  let pendingUpdate: Record<string, unknown> | null = null
  const rows = (): unknown => {
    switch (table) {
      case 'response_sla_config': return m.config ? [m.config] : []
      case 'accounts': return { timezone: 'America/Guatemala' }
      case 'conversations': return pendingUpdate ? { id: 'conv1' } : m.convs
      case 'messages': return m.msgs
      case 'contact_tags': return m.tags.map((name) => ({ tags: { name } }))
      case 'response_sla_events': return pendingInsert ? (m.claimFails ? null : { id: 'ev1' }) : m.done
      case 'contacts': return { name: 'Ana', phone: '+50211112222' }
      default: return null
    }
  }
  const c: Record<string, unknown> = {
    select: () => c, eq: () => c, or: () => c, gte: () => c, lte: () => c, is: () => c, limit: () => c, order: () => c, in: () => c,
    insert: (row: unknown) => { pendingInsert = row; m.inserts.push({ table, row }); return c },
    update: (row: Record<string, unknown>) => { pendingUpdate = row; m.updates.push({ table, row }); return c },
    maybeSingle: async () => {
      const v = rows()
      return { data: Array.isArray(v) ? v[0] ?? null : v, error: null }
    },
    then: (ok: (v: unknown) => unknown) => { const v = rows(); return ok({ data: v, error: null }) },
  }
  return c
}
const db = { from: (t: string) => chain(t) } as never

vi.mock('@/lib/ai/muted-contact', () => ({ contactMutesAi: async () => m.muted }))
vi.mock('@/lib/messaging/window', () => ({ isWithinMessagingWindow: async () => m.inWindow }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: m.sent }))
vi.mock('@/lib/conversations/reassign', () => ({
  loadAssignableAgents: async (_db: unknown, _a: string, o: { onlineOnly: boolean }) => (o.onlineOnly ? m.online : m.everyone),
  loadOpenAssignedCounts: async () => m.loads,
  leastLoaded: (ids: string[], counts: Map<string, number>) => [...ids].sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0))[0],
}))

import { runResponseSlaSweep } from './sweep'

// 10:40 Guatemala, customer wrote at 10:00 → 40 min waiting.
const NOW = new Date('2026-11-25T16:40:00Z')
const CUSTOMER_AT = '2026-11-25T16:00:00Z'

beforeEach(() => {
  m.config = { account_id: 'a1', alert_minutes: 10, escalate_minutes: 30, ai_ack_minutes: 60, ack_text: 'Recibimos su mensaje.', window_start_hour: 8, window_end_hour: 20 }
  m.convs = [{ id: 'conv1', contact_id: 'c1', assigned_agent_id: 'agent1' }]
  m.msgs = [{ sender_type: 'customer', content_type: 'text', content_text: '¿Tienen disponibilidad?', created_at: CUSTOMER_AT }]
  m.tags = []
  m.done = []
  m.online = ['agent1', 'agent2']
  m.loads = new Map([['agent2', 1]])
  m.inserts = []
  m.updates = []
  m.claimFails = false
  m.muted = false
  m.inWindow = true
  m.sent.mockClear()
})

const notices = () => m.inserts.filter((i) => i.table === 'notifications').flatMap((i) => i.row as Record<string, unknown>[])

describe('runResponseSlaSweep', () => {
  it('at 40 min: alerts the assignee, then escalates to another online teammate', async () => {
    const r = await runResponseSlaSweep(db, NOW)
    expect(r.fired).toEqual({ alert: 1, escalate: 1, ai_ack: 0 })
    expect(notices().map((n) => n.user_id)).toEqual(['agent1', 'agent2'])
    expect(m.updates).toContainEqual({ table: 'conversations', row: { assigned_agent_id: 'agent2' } })
    expect(m.sent).not.toHaveBeenCalled()
  })

  it('escalation with nobody else online notifies the whole team', async () => {
    m.done = [{ stage: 'alert' }]
    m.online = ['agent1']
    await runResponseSlaSweep(db, NOW)
    expect(notices().map((n) => n.user_id)).toEqual(['owner1', 'agent1', 'agent2'])
    expect(m.updates.find((u) => u.table === 'conversations')).toBeUndefined()
  })

  it('at 60+ min the bot sends one acknowledgement', async () => {
    m.done = [{ stage: 'alert' }, { stage: 'escalate' }]
    await runResponseSlaSweep(db, new Date('2026-11-25T17:05:00Z'))
    expect(m.sent).toHaveBeenCalledWith(db, 'a1', expect.objectContaining({
      conversationId: 'conv1', messageType: 'text', contentText: 'Recibimos su mensaje.', senderType: 'bot',
    }))
  })

  it('no acknowledgement for a contact the AI must not talk to', async () => {
    m.done = [{ stage: 'alert' }, { stage: 'escalate' }]
    m.muted = true
    await runResponseSlaSweep(db, new Date('2026-11-25T17:05:00Z'))
    expect(m.sent).not.toHaveBeenCalled()
    expect(m.updates).toContainEqual({ table: 'response_sla_events', row: { target_user_id: null, error: 'ai_muted_for_contact' } })
  })

  it('does nothing when a teammate already answered, for internal contacts, at night, or when another tick claimed it', async () => {
    m.msgs = [{ sender_type: 'agent', content_type: 'text', content_text: 'Con gusto', created_at: '2026-11-25T16:20:00Z' }, ...m.msgs]
    expect((await runResponseSlaSweep(db, NOW)).waiting).toBe(0)

    m.msgs = m.msgs.slice(1)
    m.tags = ['Proveedor']
    expect((await runResponseSlaSweep(db, NOW)).waiting).toBe(0)

    m.tags = []
    expect((await runResponseSlaSweep(db, new Date('2026-11-25T03:00:00Z'))).accounts).toBe(0) // 21:00 local

    m.claimFails = true
    const r = await runResponseSlaSweep(db, NOW)
    expect(r.fired).toEqual({ alert: 0, escalate: 0, ai_ack: 0 })
    expect(notices()).toEqual([])
  })
})
