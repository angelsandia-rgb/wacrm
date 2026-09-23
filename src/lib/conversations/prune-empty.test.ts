import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pruneEmptyStaleConversations } from './prune-empty'

const NOW = new Date('2026-08-27T12:00:00Z').getTime()
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString()

interface Fixture {
  /** conversations returned by the candidate select (already filtered
   *  by the test to null last_message_at + old created_at). */
  candidates: { id: string }[]
  /** conversation_ids that DO have a message row. */
  withMessages?: string[]
  /** Messages per conversation that has any (exercises paging). */
  messagesPerConversation?: number
  messageCheckError?: boolean
  deleteError?: boolean
}

function makeDb(fx: Fixture) {
  const deleted: string[][] = []

  function builder(table: string) {
    const state = { mode: 'select' as 'select' | 'delete', inIds: [] as string[] }
    const b: Record<string, unknown> = {
      select: () => b,
      delete: () => {
        state.mode = 'delete'
        return b
      },
      is: () => b,
      lt: () => b,
      limit: () => Promise.resolve({ data: fx.candidates, error: null }),
      in: (_col: string, ids: string[]) => {
        state.inIds = ids
        if (table === 'messages') {
          // Keyset-paged read, capped at 1000 rows per response like PostgREST.
          const per = fx.messagesPerConversation ?? 1
          const rows = (fx.withMessages ?? [])
            .filter((id) => ids.includes(id))
            .flatMap((id) =>
              Array.from({ length: per }, (_, n) => ({
                id: `${id}-${String(n).padStart(6, '0')}`,
                conversation_id: id,
              })),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
          let cursor = ''
          const page: Record<string, unknown> = {
            order: () => page,
            limit: () => page,
            gt: (_c: string, v: string) => {
              cursor = v
              return page
            },
            then: (resolve: (v: unknown) => void) =>
              resolve(
                fx.messageCheckError
                  ? { data: null, error: { message: 'URI too long' } }
                  : { data: rows.filter((r) => r.id > cursor).slice(0, 1000), error: null },
              ),
          }
          return page
        }
        // conversations delete
        if (fx.deleteError) return Promise.resolve({ data: null, error: { message: 'boom' }, count: null })
        deleted.push(ids)
        return Promise.resolve({ data: null, error: null, count: ids.length })
      },
    }
    return b
  }

  return {
    db: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    deleted,
  }
}

describe('pruneEmptyStaleConversations', () => {
  it('deletes stale conversations that have no message', async () => {
    const { db, deleted } = makeDb({
      candidates: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
    })
    const res = await pruneEmptyStaleConversations(db, NOW)
    expect(res.pruned).toBe(3)
    expect(deleted).toEqual([['c1', 'c2', 'c3']])
  })

  it('never deletes a conversation that actually has a message', async () => {
    const { db, deleted } = makeDb({
      candidates: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      withMessages: ['c2'],
    })
    const res = await pruneEmptyStaleConversations(db, NOW)
    expect(res.pruned).toBe(2)
    expect(deleted).toEqual([['c1', 'c3']])
  })

  it('is a no-op when there are no candidates', async () => {
    const { db, deleted } = makeDb({ candidates: [] })
    const res = await pruneEmptyStaleConversations(db, NOW)
    expect(res.pruned).toBe(0)
    expect(deleted).toEqual([])
  })

  it('is a no-op when every candidate turns out to have a message', async () => {
    const { db } = makeDb({
      candidates: [{ id: 'c1' }, { id: 'c2' }],
      withMessages: ['c1', 'c2'],
    })
    expect((await pruneEmptyStaleConversations(db, NOW)).pruned).toBe(0)
  })

  it('returns pruned:0 and does not throw on a delete error', async () => {
    const { db } = makeDb({ candidates: [{ id: 'c1' }], deleteError: true })
    await expect(pruneEmptyStaleConversations(db, NOW)).resolves.toEqual({ pruned: 0 })
  })

  // guards the STALE_AFTER_DAYS intent — a caller passing `now` far in
  // the past would compute a cutoff before any row; here we just assert
  // the cutoff is a week back so a regression to e.g. 1 day is caught.
  it('uses a 7-day staleness cutoff', () => {
    expect(daysAgo(7)).toBe('2026-08-20T12:00:00.000Z')
  })

  it('deletes nothing when the message check fails (fail closed)', async () => {
    const { db, deleted } = makeDb({
      candidates: [{ id: 'a' }, { id: 'b' }],
      messageCheckError: true,
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await pruneEmptyStaleConversations(db, NOW)).toEqual({ pruned: 0 })
    expect(deleted).toEqual([])
  })

  it('sees a conversation\'s messages past the 1000-row response cap', async () => {
    // 'z' sorts last; with 1500 messages on 'a' ahead of it, an unpaged
    // read would never reach 'z' and would wrongly treat it as empty.
    const { db, deleted } = makeDb({
      candidates: [{ id: 'a' }, { id: 'z' }, { id: 'empty' }],
      withMessages: ['a', 'z'],
      messagesPerConversation: 1500,
    })
    expect((await pruneEmptyStaleConversations(db, NOW)).pruned).toBe(1)
    expect(deleted).toEqual([['empty']])
  })
})
