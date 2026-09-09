import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createVisit, updateVisit } from './visits'

/**
 * Mock supabase.
 *  - products.select…maybeSingle → { price }
 *  - visits.select…maybeSingle → the "current" row (for updateVisit)
 *  - visits.insert(row).select().single() → row + id
 *  - visits.update(patch)…maybeSingle → patch + id
 *  - visit_note_revisions.insert() → records
 *  - appointments.* → no-op
 */
function makeStub(opts: { price?: number | null; current?: Record<string, unknown> | null } = {}) {
  const calls = {
    visitInsert: [] as Record<string, unknown>[],
    visitUpdate: [] as Record<string, unknown>[],
    revisions: [] as Record<string, unknown>[],
  }
  const db = {
    from(table: string) {
      if (table === 'products') {
        const c: Record<string, unknown> = {
          select: () => c,
          eq: () => c,
          maybeSingle: async () => ({ data: opts.price == null ? null : { price: opts.price }, error: null }),
        }
        return c
      }
      if (table === 'visits') {
        const c: Record<string, unknown> = {
          select: () => c,
          eq: () => c,
          maybeSingle: async () => ({ data: opts.current ?? null, error: null }),
          insert: (row: Record<string, unknown>) => {
            calls.visitInsert.push(row)
            return { select: () => ({ single: async () => ({ data: { id: 'v1', ...row }, error: null }) }) }
          },
          update: (patch: Record<string, unknown>) => {
            calls.visitUpdate.push(patch)
            return {
              eq: () => ({
                eq: () => ({
                  select: () => ({ maybeSingle: async () => ({ data: { id: 'v1', ...patch }, error: null }) }),
                }),
              }),
            }
          },
        }
        return c
      }
      if (table === 'visit_note_revisions') {
        return { insert: async (row: Record<string, unknown>) => (calls.revisions.push(row), { error: null }) }
      }
      if (table === 'appointments') {
        const c: Record<string, unknown> = {
          select: () => c,
          eq: () => c,
          maybeSingle: async () => ({ data: null, error: null }),
          update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
          insert: async () => ({ error: null }),
        }
        return c
      }
      throw new Error('unexpected table ' + table)
    },
  } as unknown as SupabaseClient
  return { db, calls }
}

describe('createVisit', () => {
  it('resolves amount from the service when not given, seeds the first note revision', async () => {
    const { db, calls } = makeStub({ price: 350 })
    const r = await createVisit(db, 'acct', 'user', {
      patient_id: 'p1',
      service_id: 's1',
      visit_date: '2026-03-11',
      notes: '  Paciente refiere dolor  ',
    })
    expect(r.ok).toBe(true)
    expect(calls.visitInsert[0]).toMatchObject({ amount: 350, notes: 'Paciente refiere dolor', visit_date: '2026-03-11' })
    expect(calls.revisions).toHaveLength(1)
    expect(calls.revisions[0]).toMatchObject({ notes: 'Paciente refiere dolor' })
  })

  it('rejects a bad visit_date and a missing patient', async () => {
    const { db } = makeStub({ price: 1 })
    expect(await createVisit(db, 'acct', 'user', { patient_id: 'p1', visit_date: '11/03/2026' })).toMatchObject({ ok: false })
    expect(await createVisit(db, 'acct', 'user', { patient_id: '', visit_date: '2026-03-11' })).toMatchObject({ ok: false })
  })
})

describe('updateVisit — note audit', () => {
  it('snapshots the PREVIOUS note text before a change', async () => {
    const { db, calls } = makeStub({ current: { id: 'v1', notes: 'texto viejo', observations: null } })
    const r = await updateVisit(db, 'acct', 'user', 'v1', { notes: 'texto nuevo' })
    expect(r.ok).toBe(true)
    expect(calls.revisions).toHaveLength(1)
    expect(calls.revisions[0]).toMatchObject({ visit_id: 'v1', notes: 'texto viejo' })
    expect(calls.visitUpdate[0]).toMatchObject({ notes: 'texto nuevo' })
  })

  it('does NOT write a revision when notes are unchanged (only amount edited)', async () => {
    const { db, calls } = makeStub({ current: { id: 'v1', notes: 'igual', observations: null } })
    await updateVisit(db, 'acct', 'user', 'v1', { notes: 'igual', amount: 500 })
    expect(calls.revisions).toHaveLength(0)
    expect(calls.visitUpdate[0]).toMatchObject({ amount: 500 })
  })

  it('404s an unknown visit and rejects an empty patch', async () => {
    expect(await updateVisit(makeStub({ current: null }).db, 'acct', 'user', 'x', { notes: 'y' })).toMatchObject({
      ok: false,
      status: 404,
    })
    expect(
      await updateVisit(makeStub({ current: { id: 'v1', notes: null, observations: null } }).db, 'acct', 'user', 'v1', {}),
    ).toMatchObject({ ok: false })
  })
})
