import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getFreeSlots, loadDoctorBusy } from './appointments'

/**
 * Stub for the reads `getFreeSlots` / `loadDoctorBusy` do:
 *  - doctor_profiles …maybeSingle  → { id, is_active }
 *  - doctor_availability …(await)   → rows
 *  - doctor_time_off …(await)       → rows
 *  - appointments …(await)          → busy rows (already filtered by
 *                                     doctor_id in the real query; the
 *                                     stub just returns what it's given)
 */
function makeDb(opts: {
  doctorActive?: boolean
  availability?: { day_of_week: number; start_time: string; end_time: string }[]
  timeOff?: { starts_at: string; ends_at: string; is_extra_hours: boolean }[]
  busy?: { scheduled_at: string; ends_at: string; status: string }[]
}) {
  const db = {
    from(table: string) {
      const result =
        table === 'doctor_availability'
          ? { data: opts.availability ?? [], error: null }
          : table === 'doctor_time_off'
            ? { data: opts.timeOff ?? [], error: null }
            : table === 'appointments'
              ? { data: opts.busy ?? [], error: null }
              : { data: null, error: null }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        maybeSingle: async () => ({
          data: table === 'doctor_profiles' ? { id: 'd1', is_active: opts.doctorActive ?? true } : null,
          error: null,
        }),
        then: (res: (v: unknown) => unknown) => res(result),
      }
      return chain
    },
  }
  return db as unknown as SupabaseClient
}

const MON_9_13 = [{ day_of_week: 1, start_time: '09:00', end_time: '13:00' }] // Mon 09–13 local
const TZ = 'America/Guatemala'

describe('getFreeSlots', () => {
  it('builds 30-min slots from a Monday block, at the right UTC instants', async () => {
    const db = makeDb({ availability: MON_9_13 })
    const slots = await getFreeSlots(db, 'acct', {
      doctorId: 'd1',
      from: '2026-03-09T00:00:00Z', // Monday
      to: '2026-03-10T00:00:00Z',
      durationMinutes: 30,
      timezone: TZ,
      nowISO: '2026-03-01T00:00:00Z',
    })
    // 09:00 local = 15:00Z … last 30-min slot starts 12:30 local = 18:30Z
    expect(slots[0].start).toBe('2026-03-09T15:00:00.000Z')
    expect(slots.at(-1)!.start).toBe('2026-03-09T18:30:00.000Z')
    expect(slots).toHaveLength(8)
  })

  it('drops slots that collide with a blocking appointment', async () => {
    const db = makeDb({
      availability: MON_9_13,
      busy: [{ scheduled_at: '2026-03-09T15:30:00Z', ends_at: '2026-03-09T16:30:00Z', status: 'CONFIRMED' }],
    })
    const starts = (
      await getFreeSlots(db, 'acct', {
        doctorId: 'd1',
        from: '2026-03-09T00:00:00Z',
        to: '2026-03-10T00:00:00Z',
        durationMinutes: 30,
        timezone: TZ,
        nowISO: '2026-03-01T00:00:00Z',
      })
    ).map((s) => s.start)
    expect(starts).toContain('2026-03-09T15:00:00.000Z')
    expect(starts).not.toContain('2026-03-09T15:30:00.000Z')
    expect(starts).not.toContain('2026-03-09T16:00:00.000Z')
    expect(starts).toContain('2026-03-09T16:30:00.000Z')
  })

  it('a CANCELLED appointment does not block its slot', async () => {
    const db = makeDb({
      availability: MON_9_13,
      busy: [{ scheduled_at: '2026-03-09T15:00:00Z', ends_at: '2026-03-09T15:30:00Z', status: 'CANCELLED' }],
    })
    const starts = (
      await getFreeSlots(db, 'acct', {
        doctorId: 'd1',
        from: '2026-03-09T00:00:00Z',
        to: '2026-03-10T00:00:00Z',
        durationMinutes: 30,
        timezone: TZ,
        nowISO: '2026-03-01T00:00:00Z',
      })
    ).map((s) => s.start)
    expect(starts).toContain('2026-03-09T15:00:00.000Z')
  })

  it('returns nothing for an inactive doctor', async () => {
    const db = makeDb({ doctorActive: false, availability: MON_9_13 })
    expect(
      await getFreeSlots(db, 'acct', {
        doctorId: 'd1',
        from: '2026-03-09T00:00:00Z',
        to: '2026-03-10T00:00:00Z',
        durationMinutes: 30,
        timezone: TZ,
      }),
    ).toEqual([])
  })

  it('a vacation block removes its window; an extra-hours block adds one', async () => {
    const blocked = await getFreeSlots(makeDb({
      availability: MON_9_13,
      timeOff: [{ starts_at: '2026-03-09T15:00:00Z', ends_at: '2026-03-09T17:00:00Z', is_extra_hours: false }],
    }), 'acct', {
      doctorId: 'd1', from: '2026-03-09T00:00:00Z', to: '2026-03-10T00:00:00Z',
      durationMinutes: 30, timezone: TZ, nowISO: '2026-03-01T00:00:00Z',
    })
    expect(blocked[0].start).toBe('2026-03-09T17:00:00.000Z') // 11:00 local

    const extra = await getFreeSlots(makeDb({
      availability: [],
      timeOff: [{ starts_at: '2026-03-09T22:00:00Z', ends_at: '2026-03-09T23:00:00Z', is_extra_hours: true }],
    }), 'acct', {
      doctorId: 'd1', from: '2026-03-09T00:00:00Z', to: '2026-03-10T00:00:00Z',
      durationMinutes: 30, timezone: TZ, nowISO: '2026-03-01T00:00:00Z',
    })
    expect(extra.map((s) => s.start)).toEqual([
      '2026-03-09T22:00:00.000Z',
      '2026-03-09T22:30:00.000Z',
    ])
  })
})

describe('loadDoctorBusy', () => {
  it('keeps only the statuses that still occupy a slot', async () => {
    const db = makeDb({
      busy: [
        { scheduled_at: '2026-03-09T15:00:00Z', ends_at: '2026-03-09T15:30:00Z', status: 'SCHEDULED' },
        { scheduled_at: '2026-03-09T16:00:00Z', ends_at: '2026-03-09T16:30:00Z', status: 'COMPLETED' },
        { scheduled_at: '2026-03-09T17:00:00Z', ends_at: '2026-03-09T17:30:00Z', status: 'CANCELLED' },
        { scheduled_at: '2026-03-09T18:00:00Z', ends_at: '2026-03-09T18:30:00Z', status: 'NO_RESPONSE' },
      ],
    })
    const busy = await loadDoctorBusy(db, 'acct', 'd1', '2026-03-09T00:00:00Z', '2026-03-10T00:00:00Z')
    expect(busy.map((b) => b.start)).toEqual(['2026-03-09T15:00:00Z', '2026-03-09T18:00:00Z'])
  })
})
