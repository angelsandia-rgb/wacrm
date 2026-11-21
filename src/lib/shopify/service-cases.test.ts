import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { claimedOrder, isWarrantyClaim, openServiceCase, serviceCaseTitle, SERVICE_CASE_PREFIX, warrantyBrief } from './service-cases'
import type { OrderStatus } from './api'

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
const base = { accountId: 'a', conversationId: 'c', summary: '🤖 La IA transfirió la conversación. Último mensaje del cliente: “quiero hablar con alguien”', now }

describe('serviceCaseTitle', () => {
  it('uses the customer words, else the first line', () => {
    expect(serviceCaseTitle(base.summary)).toBe(`${SERVICE_CASE_PREFIX}quiero hablar con alguien`)
    expect(serviceCaseTitle('🤖 Pago retenido\ndetalle')).toBe(`${SERVICE_CASE_PREFIX}Pago retenido`)
  })
})

describe('openServiceCase', () => {
  it('opens one case with owner and 4 h due time for a store', async () => {
    const { db, writes } = fakeDb({ shopify_config: { account_id: 'a' }, conversations: { contact_id: 'k' } })
    await openServiceCase(db, { ...base, assigneeId: 'u1' })
    expect(writes).toEqual([{ table: 'tasks', op: 'insert', value: expect.objectContaining({
      account_id: 'a', contact_id: 'k', assigned_to: 'u1', created_by: 'u1',
      title: `${SERVICE_CASE_PREFIX}quiero hablar con alguien`, due_at: '2026-11-15T16:00:00.000Z',
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

const order = (name: string, over: Partial<OrderStatus> = {}): OrderStatus => ({
  name, createdAt: '2026-11-12T10:00:00Z', cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
  phone: null, shippingAddress: null, fulfillments: [{ displayStatus: 'DELIVERED', trackingInfo: [{ company: 'Forza', number: '4410023', url: null }] }], ...over,
})

describe('garantías (Casa Ceiba 2026-11-18)', () => {
  it('recognises damaged / defective / wrong product claims, not plain questions', () => {
    for (const t of ['mi pedido llegó dañado', 'vino quebrado', 'llegó roto', 'se rompió', 'las luces no encienden', 'la freidora no calienta', 'me mandaron el color equivocado', 'tiene un defecto'])
      expect(isWarrantyClaim(t), t).toBe(true)
    for (const t of ['cuándo me llega mi pedido?', 'quiero hablar con alguien', 'tienen garantía?'])
      expect(isWarrantyClaim(t), t).toBe(false)
  })
  it('picks the order the customer named, else the latest', () => {
    const orders = [order('#1011'), order('#1010')]
    expect(claimedOrder(orders, 'el #1010 llegó roto')?.name).toBe('#1010')
    expect(claimedOrder(orders, 'llegó roto')?.name).toBe('#1011')
    expect(claimedOrder([], 'llegó roto')).toBeNull()
  })
  it('writes the Dropi text from Shopify facts and the customer words', () => {
    const brief = warrantyBrief(order('#1010'), '🤖 La IA transfirió la conversación. Último mensaje del cliente: “las luces no encienden”')
    expect(brief).toContain('Pedido Shopify: #1010 (creado 2026-11-12)')
    expect(brief).toContain('DELIVERED · guía Forza 4410023')
    expect(brief).toContain('Problema que reporta el cliente: las luces no encienden')
    expect(warrantyBrief(null, 'x')).toContain('pídale el número al cliente')
  })
  it('opens the case as a warranty even when the order lookup fails', async () => {
    const { db, writes } = fakeDb({ shopify_config: { account_id: 'a' }, conversations: { contact_id: 'k' } })
    await openServiceCase(db, { ...base, summary: '🤖 La IA transfirió la conversación. Último mensaje del cliente: “me llegó roto”', assigneeId: 'u1' })
    expect(writes[0].value).toMatchObject({ title: `${SERVICE_CASE_PREFIX}Garantía — me llegó roto` })
    expect((writes[0].value as { notes: string }).notes).toContain('GARANTÍA DROPI')
  })
})
