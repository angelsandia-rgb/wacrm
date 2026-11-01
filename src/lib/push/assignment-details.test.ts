import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enrichAssignment } from './assignment-details'
import { notificationPushPayload } from './notification-payload'

describe('assignment notification context', () => {
  it('includes the customer, payment motive, formal action and literal message in an assignment push', async () => {
    const filters: unknown[][] = []
    const db = { from(table: string) {
      const data = table === 'conversations' ? { id: 'chat', contacts: { name: 'Vicky' } } : [
        { sender_type: 'customer', content_type: 'text', content_text: 'Gracias', created_at: '2026-10-24T18:01:00Z' },
        { sender_type: 'customer', content_type: 'text', content_text: 'Adjunto deposito', created_at: '2026-10-24T18:00:00Z' },
      ]
      const result = { data, error: null }
      const chain = { select: () => chain, eq: (...args: unknown[]) => { filters.push(args); return chain }, neq: () => chain,
        lte: (...args: unknown[]) => { filters.push(args); return chain }, order: () => chain, limit: () => chain,
        maybeSingle: async () => result, then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) }
      return chain
    } } as unknown as SupabaseClient
    const row = await enrichAssignment(db, { id: 'n', account_id: 'hotel', type: 'conversation_assigned', title: 'New conversation assigned', body: 'Someone assigned you a conversation with Vicky', conversation_id: 'chat', created_at: '2026-10-24T18:02:00Z' })
    const push = notificationPushPayload(row)
    expect(push.title).toBe('Conversación asignada: Vicky')
    expect(push.body).toContain('comprobante de pago')
    expect(push.body).toContain('Revise el comprobante')
    expect(push.body).toContain('Gracias')
    expect(push.body).not.toContain('Abra el chat para darle seguimiento')
    expect(push.body!.length).toBeLessThanOrEqual(300)
    expect(filters).toContainEqual(['account_id', 'hotel'])
    expect(filters).toContainEqual(['conversations.account_id', 'hotel'])
    expect(filters).toContainEqual(['created_at', '2026-10-24T18:02:00Z'])
  })
  it('does not query or change an already detailed assignment or another notification type', async () => {
    const db = { from() { throw Error('Unexpected query') } } as unknown as SupabaseClient
    for (const row of [{ account_id: 'hotel', type: 'ai_handoff', body: 'Motivo: pago' }, { account_id: 'hotel', type: 'conversation_assigned', conversation_id: 'c', body: 'Motivo: pago' }]) expect(await enrichAssignment(db, row)).toBe(row)
  })
  it('does not read messages if the conversation is outside the account or inaccessible', async () => {
    const db = { from(table: string) {
      expect(table).toBe('conversations')
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) }
      return chain
    } } as unknown as SupabaseClient
    const row = { account_id: 'hotel', type: 'conversation_assigned', conversation_id: 'foreign', body: 'Original' }
    expect(await enrichAssignment(db, row)).toBe(row)
  })
})
