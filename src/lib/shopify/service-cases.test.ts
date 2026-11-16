import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { openServiceCase, serviceCaseTitle, SERVICE_CASE_PREFIX } from './service-cases'

/** Chainable fake: every query on `table` resolves to rows[table]; writes are recorded. */
function fakeDb(rows: Record<string, unknown>) {
  const writes: { table: string; op: string; value: unknown }[] = []
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {}
      const chain = () => q
      for (const m of ['select', 'eq', 'like', 'limit']) q[m] = chain
      q.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
      q.insert = async (value: unknown) => { writes.push({ table, op: 'insert', value }); return { error: null } }
      q.update = (value: unknown) => { writes.push({ table, op: 'update', value }); return { eq: async () => ({ error: null }) } }
      return q
    },
  }
  return { db: db as unknown as SupabaseClient, writes }
}

const now = new Date('2026-11-15T12:00:00Z')
const base = { accountId: 'a', conversationId: 'c', summary: '🤖 La IA transfirió la conversación. Último mensaje del cliente: “me llegó roto”', now }

describe('serviceCaseTitle', () => {
  it('uses the customer words, else the first line', () => {
    expect(serviceCaseTitle(base.summary)).toBe(`${SERVICE_CASE_PREFIX}me llegó roto`)
    expect(serviceCaseTitle('🤖 Pago retenido\ndetalle')).toBe(`${SERVICE_CASE_PREFIX}Pago retenido`)
  })
})

describe('openServiceCase', () => {
  it('opens one case with owner and 4 h due time for a store', async () => {
    const { db, writes } = fakeDb({ shopify_config: { account_id: 'a' }, conversations: { contact_id: 'k' } })
    await openServiceCase(db, { ...base, assigneeId: 'u1' })
    expect(writes).toEqual([{ table: 'tasks', op: 'insert', value: expect.objectContaining({
      account_id: 'a', contact_id: 'k', assigned_to: 'u1', created_by: 'u1',
      title: `${SERVICE_CASE_PREFIX}me llegó roto`, due_at: '2026-11-15T16:00:00.000Z',
    }) }])
  })

  it('appends to the open case instead of opening a second one', async () => {
    const { db, writes } = fakeDb({ shopify_config: { account_id: 'a' }, conversations: { contact_id: 'k' }, tasks: { id: 't', notes: 'antes' } })
    await openServiceCase(db, { ...base, assigneeId: 'u1' })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ table: 'tasks', op: 'update' })
  })

  it('does nothing for an account without a store', async () => {
    const { db, writes } = fakeDb({ conversations: { contact_id: 'k' } })
    await openServiceCase(db, { ...base, assigneeId: 'u1' })
    expect(writes).toEqual([])
  })
})
