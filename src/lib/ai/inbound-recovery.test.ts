import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('./auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }))
// Which conversations count as answered (an outbound text after the
// customer's message, app greeting echoes already dropped).
const answeredIds = vi.hoisted(() => new Set<string>())
vi.mock('./human-reply', () => ({
  loadTrailingOutbound: async (_db: unknown, conversationId: string) => ({
    lastCustomerAt: null,
    humanSince: null,
    rows: answeredIds.has(conversationId)
      ? [{ sender_type: 'agent', content_type: 'text', content_text: 'hola', created_at: '' }]
      : [],
  }),
}))

import { recoverUnansweredInbound } from './inbound-recovery'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

interface Fixture {
  conversations: { id: string; account_id: string; contact_id: string | null; last_message_at: string }[]
  /** The customer's latest message per conversation. */
  lastCustomer: Record<string, { id: string; sender_type: string; content_type: string; created_at: string } | null>
  /** Conversations with an outbound TEXT after the customer's message. */
  answered?: string[]
  flowTouches?: Record<string, number>
  /** Prior recovery attempts per message id. */
  claimed?: Record<string, number>
}

function db(fx: Fixture) {
  answeredIds.clear()
  for (const id of fx.answered ?? []) answeredIds.add(id)
  const inserts: Record<string, unknown>[] = []
  const client = {
    from(table: string) {
      const filters: Record<string, string> = {}
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, v: string) => {
          filters[col] = v
          return chain
        },
        in: () => chain,
        gt: () => chain,
        is: () => chain,
        gte: () => chain,
        lte: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row)
          return { error: null }
        },
        maybeSingle: async () => {
          if (table === 'messages') return { data: fx.lastCustomer[filters.conversation_id] ?? null, error: null }
          if (table === 'accounts') return { data: { owner_user_id: 'owner-1' }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === 'conversations') return resolve({ data: fx.conversations, error: null })
          if (table === 'messages') {
            const answered = (fx.answered ?? []).includes(filters.conversation_id)
            return resolve({ data: answered ? [{ id: 'reply' }] : [], error: null })
          }
          if (table === 'flow_runs') return resolve({ count: fx.flowTouches?.[filters.conversation_id] ?? 0, error: null })
          if (table === 'ai_action_log') {
            const n = fx.claimed?.[filters['input->>message_id']] ?? 0
            return resolve({ data: Array.from({ length: n }, (_, i) => ({ id: `x${i}` })), error: null })
          }
          return resolve({ data: [], error: null })
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, inserts }
}

const conv = (id: string, m = 10) => ({ id, account_id: 'acct-1', contact_id: `contact-${id}`, last_message_at: minsAgo(m) })
const customerText = (id: string, m = 10) => ({ id, sender_type: 'customer', content_type: 'text', created_at: minsAgo(m) })

describe('recoverUnansweredInbound', () => {
  it('re-dispatches a customer text left unanswered, once, without the debounce wait', async () => {
    const dispatch = vi.fn()
    const { client, inserts } = db({ conversations: [conv('c1')], lastCustomer: { c1: customerText('m1') } })
    const res = await recoverUnansweredInbound(client, { now: NOW, dispatch })
    expect(res.recovered).toBe(1)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', contactId: 'contact-c1', configOwnerUserId: 'owner-1', skipDebounce: true }),
    )
    expect(inserts[0]).toMatchObject({ action: 'inbound_recovery', target_id: 'c1', input: { message_id: 'm1' } })
  })

  it('still recovers when only our banner/photos went out before the reply was lost (prueba #27)', async () => {
    const dispatch = vi.fn()
    // The thread's last message is our image, but no TEXT followed the
    // customer's message — `answered` is empty.
    const { client } = db({ conversations: [conv('c1')], lastCustomer: { c1: customerText('m1', 12) } })
    const res = await recoverUnansweredInbound(client, { now: NOW, dispatch })
    expect(res.recovered).toBe(1)
  })

  it('leaves answered, retried 3 times, flow-consumed, non-text and too-recent messages alone', async () => {
    const dispatch = vi.fn()
    const { client } = db({
      conversations: [conv('answered'), conv('retried'), conv('flow'), conv('image'), conv('fresh', 2)],
      lastCustomer: {
        answered: customerText('m1'),
        retried: customerText('m2'),
        flow: customerText('m3'),
        image: { id: 'm4', sender_type: 'customer', content_type: 'image', created_at: minsAgo(10) },
        fresh: customerText('m5', 2),
      },
      answered: ['answered'],
      flowTouches: { flow: 1 },
      claimed: { m2: 3 },
    })
    const res = await recoverUnansweredInbound(client, { now: NOW, dispatch })
    expect(res.recovered).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('retries a message whose earlier attempts failed to send, up to 3 times (Zernio outage, VSR 2026-10-08)', async () => {
    const dispatch = vi.fn()
    const { client } = db({ conversations: [conv('c1')], lastCustomer: { c1: customerText('m1') }, claimed: { m1: 2 } })
    const res = await recoverUnansweredInbound(client, { now: NOW, dispatch })
    expect(res.recovered).toBe(1)
  })
})
