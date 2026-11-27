import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown> | Record<string, unknown>[] | null>,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
}))

function chain(table: string) {
  const c: Record<string, unknown> = {
    select: () => c, eq: () => c, in: () => c, gte: () => c, order: () => c, limit: () => c,
    update: () => c,
    insert: async (row: Record<string, unknown>) => { m.inserts.push({ table, row }); return { error: null } },
    maybeSingle: async () => {
      const v = m.tables[table]
      return { data: Array.isArray(v) ? v[0] ?? null : v ?? null, error: null }
    },
    then: (ok: (v: unknown) => unknown) => {
      const v = m.tables[table]
      return ok({ data: Array.isArray(v) ? v : v ? [v] : [], error: null })
    },
  }
  return c
}

vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: vi.fn(async () => ({ messageId: 'msg1' })),
  SendMessageError: class extends Error {},
}))

import { dispatchCsat } from './dispatch'

const CONFIG = {
  enabled: true, template_name: null, template_language: null, scale: 5, delay_minutes: 1440, cooldown_days: 30,
  moments: { conversation_closed: { template_name: 'encuesta_cierre', template_language: 'es' } },
}

beforeEach(() => {
  m.inserts = []
  m.tables = {
    csat_config: CONFIG,
    conversations: { contact_id: 'c1', channel: 'whatsapp', closed_at: '2026-11-24T00:00:00Z' },
    csat_surveys: null,
    contact_tags: [],
  }
})

describe('CSAT on conversation close', () => {
  it('queues a survey for the closed conversation, sent on the next tick', async () => {
    await dispatchCsat({} as never, 'a1', 'conversation.closed', { conversation_id: 'conv1' })
    const row = m.inserts.find((i) => i.table === 'csat_surveys')?.row
    expect(row).toMatchObject({
      trigger: 'conversation_closed', contact_id: 'c1', conversation_id: 'conv1', status: 'pending',
      source_key: 'close:conv1:2026-11-24T00:00:00Z',
    })
  })

  it('skips non-customers (Proveedor / Interno / Personal)', async () => {
    m.tables.contact_tags = [{ tags: { name: 'Proveedor' } }]
    await dispatchCsat({} as never, 'a1', 'conversation.closed', { conversation_id: 'conv1' })
    expect(m.inserts.find((i) => i.table === 'csat_surveys')?.row).toMatchObject({ status: 'skipped', skip_reason: 'non_customer_contact' })
  })

  it('still surveys a "Sin IA" customer (that tag only silences the bot)', async () => {
    m.tables.contact_tags = [{ tags: { name: 'Sin IA' } }]
    await dispatchCsat({} as never, 'a1', 'conversation.closed', { conversation_id: 'conv1' })
    expect(m.inserts.find((i) => i.table === 'csat_surveys')?.row).toMatchObject({ status: 'pending', trigger: 'conversation_closed' })
  })

  it('does nothing when the account did not choose that moment', async () => {
    m.tables.csat_config = { ...CONFIG, moments: { deal_won: { template_name: 'x', template_language: 'es' } } }
    await dispatchCsat({} as never, 'a1', 'conversation.closed', { conversation_id: 'conv1' })
    expect(m.inserts).toEqual([])
  })
})

describe('CSAT response', () => {
  it('turns a 2/5 into a task for the owner', async () => {
    m.tables.csat_surveys = { id: 's1', deal_id: null, contact_id: 'c1', scale: 5, sent_at: 'x', trigger: 'order_delivered' }
    m.tables.profiles = { user_id: 'owner1' }
    m.tables.contacts = { name: 'Ana', phone: '+50211112222' }
    const follow = await dispatchCsat({} as never, 'a1', 'message.received', { contact_id: 'c1', text: '2' })
    expect(follow?.data).toMatchObject({ score: 2, trigger: 'order_delivered' })
    expect(m.inserts.find((i) => i.table === 'tasks')?.row).toMatchObject({
      assigned_to: 'owner1', contact_id: 'c1', title: 'Cliente insatisfecho (2/5): Ana',
    })
  })

  it('a happy 5/5 creates no task', async () => {
    m.tables.csat_surveys = { id: 's1', deal_id: null, contact_id: 'c1', scale: 5, sent_at: 'x', trigger: 'order_created' }
    await dispatchCsat({} as never, 'a1', 'message.received', { contact_id: 'c1', text: '5' })
    expect(m.inserts.find((i) => i.table === 'tasks')).toBeUndefined()
  })
})
