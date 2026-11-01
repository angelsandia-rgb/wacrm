import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncHotelReservationDeal } from './sync-hotel-reservation'

function fixture(status = 'pending', confirmed: string | null = null, deals: Record<string, unknown>[] = []) {
  const writes: { table: string; operation: string; value: Record<string, unknown> }[] = []
  const filters: unknown[][] = []
  const rows: Record<string, unknown> = {
    accounts: { industry_vertical: 'hotel', owner_user_id: 'owner', default_currency: 'GTQ' },
    reservation_requests: { id: 'r1', category: 'habitaciones', status, guest_confirmed_at: confirmed, contact_id: 'contact', conversation_id: 'conversation', service_name: 'Junior Suite', is_active_build: true },
    pipelines: [{ id: 'rooms', name: 'Habitaciones' }],
    pipeline_stages: [{ id: 'quote', name: 'Cotizando' }, { id: 'pending', name: 'Pendiente de confirmación' }, { id: 'won', name: 'Visita confirmada', is_won: true }, { id: 'lost', name: 'Descarte' }], deals,
  }
  const db = { from(table: string) {
    const result = { data: rows[table], error: null }
    const chain = { select: () => chain, eq: (...args: unknown[]) => { filters.push([table, ...args]); return chain }, or: () => chain, order: () => chain,
      maybeSingle: async () => result, then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      update: (value: Record<string, unknown>) => { writes.push({ table, operation: 'update', value }); return chain },
      upsert: (value: Record<string, unknown>) => { writes.push({ table, operation: 'upsert', value }); return chain } }
    return chain
  } } as unknown as SupabaseClient
  return { db, rows, writes, filters }
}

describe('hotel reservation pipeline synchronization', () => {
  it.each([
    ['pending', null, 'quote', 'open'],
    ['pending', '2026-10-20T03:00:00Z', 'pending', 'open'],
    ['approved', null, 'won', 'won'],
    ['denied', null, 'lost', 'lost'],
  ])('maps %s / guest=%s to %s without altering the booking', async (status, confirmed, stage, dealStatus) => {
    const f = fixture(status!, confirmed)
    await syncHotelReservationDeal(f.db, 'hotel', 'r1')
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0]).toMatchObject({ table: 'deals', value: { id: 'r1', stage_id: stage, status: dealStatus, account_id: 'hotel' } })
    expect(f.filters).toContainEqual(['reservation_requests', 'account_id', 'hotel'])
  })
  it('does not reopen a manually discarded linked opportunity during AI enrichment', async () => {
    const f = fixture('pending', null, [{ id: 'd', status: 'lost', notes: 'Solicitud de reserva: r1', stage_id: 'lost' }])
    await syncHotelReservationDeal(f.db, 'hotel', 'r1')
    expect(f.writes).toEqual([])
  })
  it('does not move pending confirmation back to quoting on a field update', async () => {
    const f = fixture('pending', null, [{ id: 'd', status: 'open', notes: 'Solicitud de reserva: r1', stage_id: 'pending' }])
    await syncHotelReservationDeal(f.db, 'hotel', 'r1')
    expect(f.writes).toEqual([])
  })
  it('adopts the existing open opportunity rather than creating another card', async () => {
    const f = fixture('approved', null, [{ id: 'legacy', status: 'open', stage_id: 'pending', notes: 'Nota de Ana' }])
    await syncHotelReservationDeal(f.db, 'hotel', 'r1')
    expect(f.writes[0]).toMatchObject({ operation: 'update', value: { stage_id: 'won', status: 'won', notes: 'Nota de Ana\nSolicitud de reserva: r1' } })
  })
  it('leaves other accounts and nonconfigured pipelines alone', async () => {
    const f = fixture()
    f.rows.accounts = { industry_vertical: 'retail' }
    await syncHotelReservationDeal(f.db, 'hotel', 'r1')
    expect(f.writes).toEqual([])
    f.rows.accounts = { industry_vertical: 'hotel' }
    f.rows.pipeline_stages = [{ id: '1', name: 'Conversación' }]
    await syncHotelReservationDeal(f.db, 'hotel', 'r1')
    expect(f.writes).toEqual([])
  })
})
