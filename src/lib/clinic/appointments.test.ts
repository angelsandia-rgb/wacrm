import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAppointment } from './appointments'

const FUTURE = new Date(Date.now() + 3 * 86_400_000)
// snap to 09:00 local-ish; exact value irrelevant to these tests
FUTURE.setUTCHours(15, 0, 0, 0)
const START = FUTURE.toISOString()

/**
 * Minimal supabase stub.
 *  - products.select…maybeSingle → { duration_minutes, price }
 *  - appointments.select…(await) → { data: busyRows }
 *  - appointments.insert(rows).select() → echoes rows with ids
 *  - appointment_history.insert() → ok
 */
function makeStub(opts: {
  service?: { duration_minutes: number | null; price: number | null }
  busy?: { scheduled_at: string; ends_at: string; status: string }[]
}) {
  const inserted: { table: string; rows: Record<string, unknown>[] }[] = []
  const busy = opts.busy ?? []

  const db = {
    from(table: string) {
      if (table === 'products') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: opts.service ?? null, error: null }),
        }
        return chain
      }
      if (table === 'appointments') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          neq: () => chain,
          lt: () => chain,
          gt: () => chain,
          then: (res: (v: unknown) => unknown) => res({ data: busy, error: null }),
          insert: (rows: Record<string, unknown>[]) => {
            inserted.push({ table, rows })
            return {
              select: async () => ({
                data: rows.map((r, i) => ({ id: `appt-${i}`, scheduled_at: r.scheduled_at })),
                error: null,
              }),
            }
          },
        }
        return chain
      }
      if (table === 'appointment_history') {
        return { insert: async (rows: Record<string, unknown>[]) => (inserted.push({ table, rows }), { error: null }) }
      }
      throw new Error('unexpected table ' + table)
    },
  } as unknown as SupabaseClient

  return { db, inserted }
}

describe('createAppointment', () => {
  it('rejects a time that collides with a blocking appointment', async () => {
    const { db } = makeStub({
      service: { duration_minutes: 30, price: 300 },
      busy: [{ scheduled_at: START, ends_at: new Date(FUTURE.getTime() + 30 * 60000).toISOString(), status: 'CONFIRMED' }],
    })
    const r = await createAppointment(db, 'acct', 'user', {
      patient_id: 'p1',
      doctor_id: 'd1',
      service_id: 's1',
      scheduled_at: START,
    })
    expect(r).toMatchObject({ ok: false, status: 409 })
  })

  it('ignores a cancelled appointment at the same time', async () => {
    const { db, inserted } = makeStub({
      service: { duration_minutes: 30, price: 300 },
      busy: [{ scheduled_at: START, ends_at: START, status: 'CANCELLED' }],
    })
    const r = await createAppointment(db, 'acct', 'user', {
      patient_id: 'p1',
      doctor_id: 'd1',
      service_id: 's1',
      scheduled_at: START,
    })
    expect(r.ok).toBe(true)
    const appt = inserted.find((x) => x.table === 'appointments')!
    expect(appt.rows).toHaveLength(1)
    expect(appt.rows[0]).toMatchObject({ status: 'SCHEDULED', amount: 300, confirmation_status: 'pending' })
  })

  it('resolves duration + amount from the service when not given', async () => {
    const { db, inserted } = makeStub({ service: { duration_minutes: 45, price: 500 } })
    await createAppointment(db, 'acct', 'user', {
      patient_id: 'p1',
      doctor_id: 'd1',
      service_id: 's1',
      scheduled_at: START,
    })
    const row = inserted.find((x) => x.table === 'appointments')!.rows[0]
    const mins = (new Date(row.ends_at as string).getTime() - new Date(row.scheduled_at as string).getTime()) / 60000
    expect(mins).toBe(45)
    expect(row.amount).toBe(500)
  })

  it('expands a weekly recurrence into N rows sharing a group id', async () => {
    const { db, inserted } = makeStub({ service: { duration_minutes: 30, price: 200 } })
    const r = await createAppointment(db, 'acct', 'user', {
      patient_id: 'p1',
      doctor_id: 'd1',
      service_id: 's1',
      scheduled_at: START,
      recurrence: { frequency: 'weekly', count: 4 },
    })
    expect(r.ok).toBe(true)
    const rows = inserted.find((x) => x.table === 'appointments')!.rows
    expect(rows).toHaveLength(4)
    const groups = new Set(rows.map((x) => x.recurrence_group_id))
    expect(groups.size).toBe(1)
    expect([...groups][0]).toBeTruthy()
    // 7 days apart
    const t0 = new Date(rows[0].scheduled_at as string).getTime()
    const t1 = new Date(rows[1].scheduled_at as string).getTime()
    expect((t1 - t0) / 86_400_000).toBe(7)
  })

  it('rejects a past date and a missing patient/doctor', async () => {
    const { db } = makeStub({ service: { duration_minutes: 30, price: 1 } })
    expect(
      await createAppointment(db, 'acct', 'user', {
        patient_id: 'p1',
        doctor_id: 'd1',
        scheduled_at: '2020-01-01T10:00:00Z',
      }),
    ).toMatchObject({ ok: false })
    expect(
      await createAppointment(db, 'acct', 'user', { patient_id: '', doctor_id: 'd1', scheduled_at: START }),
    ).toMatchObject({ ok: false })
  })
})

// crypto.randomUUID is available in the vitest (node) env; guard just in case.
if (typeof crypto === 'undefined' || !crypto.randomUUID) {
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' })
}
