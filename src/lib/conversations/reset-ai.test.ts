import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resetConversationAiState } from './reset-ai'

/** Minimal fake covering the four tables touched: flow_runs (update),
 *  reservation_requests (delete), conversations (update), messages
 *  (insert). Records what each call was given so assertions can check
 *  the exact shape written / filtered on. */
function fakeDb(opts: {
  flowUpdateError?: unknown
  reservationDeleteError?: unknown
  convUpdateError?: unknown
  noteInsertError?: unknown
} = {}) {
  const calls: {
    flowUpdate?: Record<string, unknown>
    reservationDeleteFilters?: { column: string; value: unknown; op: 'eq' | 'neq' }[]
    convUpdate?: Record<string, unknown>
    noteInsert?: Record<string, unknown>
  } = {}

  const chain: Record<string, unknown> = {
    from: (table: string) => {
      if (table === 'flow_runs') {
        return {
          update: (payload: Record<string, unknown>) => {
            calls.flowUpdate = payload
            return {
              eq: () => ({
                eq: () => ({
                  select: () =>
                    Promise.resolve({
                      data: opts.flowUpdateError ? null : [{ id: 'run-1' }],
                      error: opts.flowUpdateError ?? null,
                    }),
                }),
              }),
            }
          },
        }
      }
      if (table === 'reservation_requests') {
        const filters: { column: string; value: unknown; op: 'eq' | 'neq' }[] = []
        calls.reservationDeleteFilters = filters
        const builder = {
          eq: (column: string, value: unknown) => {
            filters.push({ column, value, op: 'eq' })
            return builder
          },
          neq: (column: string, value: unknown) => {
            filters.push({ column, value, op: 'neq' })
            return builder
          },
          select: () =>
            Promise.resolve({
              data: opts.reservationDeleteError ? null : [{ id: 'req-1' }, { id: 'req-2' }],
              error: opts.reservationDeleteError ?? null,
            }),
        }
        return { delete: () => builder }
      }
      if (table === 'conversations') {
        return {
          update: (payload: Record<string, unknown>) => {
            calls.convUpdate = payload
            return {
              eq: () => ({
                eq: () => Promise.resolve({ error: opts.convUpdateError ?? null }),
              }),
            }
          },
        }
      }
      if (table === 'messages') {
        return {
          insert: (payload: Record<string, unknown>) => {
            calls.noteInsert = payload
            return Promise.resolve({ error: opts.noteInsertError ?? null })
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
  return { db: chain as unknown as SupabaseClient, calls }
}

describe('resetConversationAiState', () => {
  it('ends active flow runs for the conversation', async () => {
    const { db, calls } = fakeDb()
    await resetConversationAiState(db, {
      conversationId: 'conv-1',
      accountId: 'acct-1',
      actorName: 'Angel',
    })
    expect(calls.flowUpdate).toMatchObject({
      status: 'paused_by_agent',
      end_reason: 'reset_by_agent',
    })
    expect(calls.flowUpdate?.ended_at).toBeTypeOf('string')
  })

  it('deletes non-approved reservation drafts for the conversation, never approved ones', async () => {
    const { db, calls } = fakeDb()
    await resetConversationAiState(db, {
      conversationId: 'conv-1',
      accountId: 'acct-1',
      actorName: 'Angel',
    })
    expect(calls.reservationDeleteFilters).toEqual([
      { column: 'conversation_id', value: 'conv-1', op: 'eq' },
      { column: 'status', value: 'approved', op: 'neq' },
    ])
  })

  it('clears every AI eligibility/handoff column and sets ai_context_reset_at', async () => {
    const { db, calls } = fakeDb()
    await resetConversationAiState(db, {
      conversationId: 'conv-1',
      accountId: 'acct-1',
      actorName: 'Angel',
    })
    expect(calls.convUpdate).toMatchObject({
      ai_autoreply_disabled: false,
      assigned_agent_id: null,
      ai_reply_count: 0,
      ai_handoff_at: null,
      ai_handoff_transient: null,
      ai_flow_directive: null,
      ai_handoff_summary: null,
    })
    expect(calls.convUpdate?.ai_context_reset_at).toBeTypeOf('string')
  })

  it('inserts an internal note naming the actor', async () => {
    const { db, calls } = fakeDb()
    await resetConversationAiState(db, {
      conversationId: 'conv-1',
      accountId: 'acct-1',
      actorName: 'Angel',
    })
    expect(calls.noteInsert).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'bot',
      content_type: 'internal_note',
    })
    expect(calls.noteInsert?.content_text).toContain('Angel')
  })

  it('reports how many flow runs it ended and reservation drafts it cleared', async () => {
    const { db } = fakeDb()
    const result = await resetConversationAiState(db, {
      conversationId: 'conv-1',
      accountId: 'acct-1',
      actorName: 'Angel',
    })
    expect(result).toEqual({ flowRunsEnded: 1, reservationDraftsCleared: 2 })
  })

  it('does not throw when ending flow runs fails (best-effort)', async () => {
    const { db } = fakeDb({ flowUpdateError: { message: 'boom' } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await resetConversationAiState(db, {
      conversationId: 'conv-1',
      accountId: 'acct-1',
      actorName: 'Angel',
    })
    expect(result).toEqual({ flowRunsEnded: 0, reservationDraftsCleared: 2 })
    errorSpy.mockRestore()
  })

  it('does not throw when clearing reservation drafts fails (best-effort)', async () => {
    const { db } = fakeDb({ reservationDeleteError: { message: 'boom' } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await resetConversationAiState(db, {
      conversationId: 'conv-1',
      accountId: 'acct-1',
      actorName: 'Angel',
    })
    expect(result).toEqual({ flowRunsEnded: 1, reservationDraftsCleared: 0 })
    errorSpy.mockRestore()
  })

  it('does not throw when the internal note insert fails (best-effort)', async () => {
    const { db } = fakeDb({ noteInsertError: { message: 'boom' } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      resetConversationAiState(db, {
        conversationId: 'conv-1',
        accountId: 'acct-1',
        actorName: 'Angel',
      }),
    ).resolves.toEqual({ flowRunsEnded: 1, reservationDraftsCleared: 2 })
    errorSpy.mockRestore()
  })

  it('throws when the conversation update itself fails', async () => {
    const { db } = fakeDb({ convUpdateError: { message: 'boom' } })
    await expect(
      resetConversationAiState(db, {
        conversationId: 'conv-1',
        accountId: 'acct-1',
        actorName: 'Angel',
      }),
    ).rejects.toBeTruthy()
  })
})
