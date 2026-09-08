import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadHotelMetrics } from './queries'

function db(reservations: object[], fail = false) {
  return { from(table: string) {
    let cursor = ''
    const rows = table === 'reservation_requests' ? reservations : []
    const chain = {
      select: () => chain, order: () => chain, limit: () => chain, or: () => chain,
      gt: (_: string, value: string) => { cursor = value; return chain },
      then: (resolve: (value: unknown) => void) => resolve({
        data: rows.filter((r) => (r as { id: string }).id > cursor).slice(0, 100),
        error: fail ? new Error('offline') : null,
      }),
    }
    return chain
  } } as unknown as SupabaseClient
}

describe('hotel metrics completeness', () => {
  it('reads beyond the server row cap using a stable cursor', async () => {
    const rows = Array.from({ length: 1205 }, (_, i) => ({ id: String(i).padStart(6, '0'), estimated_price: '25.50' }))
    const result = await loadHotelMetrics(db(rows), '2026-01-01T00:00:00Z')
    expect(result.reservations).toHaveLength(1205)
    expect(result.reservations[1204].estimated_price).toBe(25.5)
  })
  it('reports failures instead of presenting empty business metrics', async () => {
    await expect(loadHotelMetrics(db([], true), '2026-01-01T00:00:00Z')).rejects.toThrow('offline')
  })
})
