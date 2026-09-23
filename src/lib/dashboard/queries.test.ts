import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadConversationsSeries, loadResponseTime } from './queries'
import { localDayKey } from './date-utils'

type Row = Record<string, unknown> & { id: string }

/** Fake PostgREST that — like the real server — returns at most 1000
 *  rows per request whatever limit is asked for, and honours the
 *  keyset `gt('id')` cursor. Filters other than the cursor are ignored:
 *  every row given is "in range". */
function cappedDb(rows: Row[]): SupabaseClient {
  return {
    from() {
      let cursor = ''
      let limit = Infinity
      const chain = {
        select: () => chain,
        gte: () => chain,
        lt: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: (n: number) => {
          limit = n
          return chain
        },
        gt: (_: string, v: string) => {
          cursor = v
          return chain
        },
        then: (resolve: (v: unknown) => void) =>
          resolve({
            data: rows.filter((r) => r.id > cursor).slice(0, Math.min(limit, 1000)),
            error: null,
          }),
      }
      return chain
    },
  } as unknown as SupabaseClient
}

const id = (i: number) => `m${String(i).padStart(6, '0')}`

describe('dashboard queries past the PostgREST row cap', () => {
  it('counts every message in the series, including the most recent day', async () => {
    const now = new Date()
    // 2400 messages today — a single capped select used to drop 1400 of them.
    const rows = Array.from({ length: 2400 }, (_, i) => ({
      id: id(i),
      created_at: now.toISOString(),
      sender_type: i % 2 ? 'customer' : 'agent',
    }))
    const series = await loadConversationsSeries(cappedDb(rows), 7)
    const today = series.find((p) => p.day === localDayKey(now.toISOString()))!
    expect(today.incoming + today.outgoing).toBe(2400)
  })

  it('pairs response times per conversation regardless of page order', async () => {
    const base = Date.now() - 60 * 60_000
    // ids are assigned out of chronological order within a conversation,
    // so the pairing must sort by time, not trust the `id` paging order.
    const rows = [
      { id: id(2), conversation_id: 'c1', sender_type: 'customer', created_at: new Date(base).toISOString() },
      { id: id(1), conversation_id: 'c1', sender_type: 'agent', created_at: new Date(base + 10 * 60_000).toISOString() },
    ]
    const summary = await loadResponseTime(cappedDb(rows))
    expect(summary.thisWeekAvg ?? summary.lastWeekAvg).toBeCloseTo(10)
  })
})
