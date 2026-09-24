import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { exportEntity, isExportEntity, MAX_EXPORT_ROWS } from './bulk-export'

/**
 * Fake PostgREST: keyset-pageable (honours `.gt('id')`) and capped at 1000
 * rows per response like the real server, so a plain capped read would
 * visibly under-export. `profiles` resolves on `.eq()` (member names).
 */
function makeDb(rowsByTable: Record<string, Record<string, unknown>[]>, fail?: string): SupabaseClient {
  return {
    from(table: string) {
      const rows = (rowsByTable[table] ?? [])
        .map((r, i) => ({ id: `${table}-${String(i).padStart(6, '0')}`, ...r }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      let cursor = ''
      const result = () =>
        fail === table
          ? { data: null, error: new Error(`${table} down`) }
          : { data: rows.filter((r) => String(r.id) > cursor).slice(0, 1000), error: null }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => (table === 'profiles' ? Promise.resolve(result()) : chain),
        order: () => chain,
        limit: () => chain,
        gt: (_c: string, v: string) => {
          cursor = v
          return chain
        },
        then: (resolve: (v: unknown) => void) => resolve(result()),
      }
      return chain
    },
  } as unknown as SupabaseClient
}

describe('isExportEntity', () => {
  it('accepts the known entities and rejects anything else', () => {
    expect(isExportEntity('deals')).toBe(true)
    expect(isExportEntity('quote_items')).toBe(true)
    expect(isExportEntity('funnel')).toBe(true)
    expect(isExportEntity('messages')).toBe(false)
    expect(isExportEntity(42)).toBe(false)
  })
})

describe('exportEntity', () => {
  it('shapes contacts into a header + rows, newest first', async () => {
    const db = makeDb({
      contacts: [
        { name: 'Ana', phone: '502111', email: 'a@x.com', company: 'ACME', lead_temperature: 'hot', created_at: '2026-08-01' },
        { name: 'Beto', phone: '502222', email: null, company: null, lead_temperature: null, created_at: '2026-08-02' },
      ],
    })
    const res = await exportEntity(db, 'acct-1', 'contacts')
    expect(res.tab).toBe('Export Contactos')
    expect(res.rows[0]).toEqual(res.header)
    expect(res.rows[1][0]).toBe('Beto')
    expect(res.rows[2]).toEqual(['Ana', '502111', 'a@x.com', 'ACME', 'hot', '2026-08-01'])
    expect(res.rowCount).toBe(2)
    expect(res.truncated).toBe(false)
  })

  it('flattens the joined contact + stage and names the salesperson on a deals export', async () => {
    const db = makeDb({
      deals: [
        {
          title: 'Camisa x100', value: 1500, currency: 'GTQ', status: 'won', won_at: '2026-08-10',
          created_at: '2026-08-01', assigned_to: 'u1', user_id: 'u2',
          contacts: { name: 'Ana', phone: '502111' }, pipeline_stages: { name: 'Cerrada' },
        },
      ],
      profiles: [{ user_id: 'u1', full_name: 'Vendedora Uno', email: 'v1@x.com' }],
    })
    const res = await exportEntity(db, 'acct-1', 'deals')
    expect(res.rows[1]).toEqual(['Camisa x100', 1500, 'GTQ', 'Cerrada', 'won', '2026-08-10', 'Ana', '502111', 'Vendedora Uno', '2026-08-01'])
  })

  it('exports every row past the 1000-row server cap and truncates at MAX_EXPORT_ROWS', async () => {
    const many = Array.from({ length: MAX_EXPORT_ROWS + 5 }, (_, i) => ({
      name: `c${i}`, phone: '', email: null, company: null, lead_temperature: null,
      created_at: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    }))
    const res = await exportEntity(makeDb({ contacts: many }), 'acct-1', 'contacts')
    expect(res.truncated).toBe(true)
    expect(res.rowCount).toBe(MAX_EXPORT_ROWS)
    expect(res.rows).toHaveLength(MAX_EXPORT_ROWS + 1)
  })

  it('throws instead of writing an empty sheet when a read fails', async () => {
    await expect(exportEntity(makeDb({}, 'contacts'), 'acct-1', 'contacts')).rejects.toThrow('contacts down')
  })

  it('exports one row per quote line with product, amounts and quote status', async () => {
    const db = makeDb({
      quotes: [{ id: 'q1', status: 'accepted', currency: 'GTQ', created_at: '2026-09-01', user_id: 'u1', contacts: { name: 'Ana', phone: '502' } }],
      quote_items: [
        { quote_id: 'q1', description: 'Suite', unit_price: 800, quantity: 2, line_total: 1600, position: 0, products: { name: 'Suite Clásica' } },
        { quote_id: 'q1', description: 'Transporte', unit_price: 150, quantity: 1, line_total: 150, position: 1, products: null },
        { quote_id: 'missing', description: 'huérfano', unit_price: 1, quantity: 1, line_total: 1, position: 0 },
      ],
      profiles: [{ user_id: 'u1', full_name: 'Vendedora Uno', email: null }],
    })
    const res = await exportEntity(db, 'acct-1', 'quote_items')
    expect(res.tab).toBe('Export Cotización ítems')
    expect(res.rowCount).toBe(2)
    expect(res.rows[1]).toEqual(['2026-09-01', 'Ana', '502', 'Suite Clásica', 'Suite', 2, 800, 1600, 'GTQ', 'accepted', 'Vendedora Uno', 'q1'])
    expect(res.rows[2][3]).toBe('Transporte') // free-text line falls back to its description
  })

  it('builds one funnel row per contact with the furthest stage reached', async () => {
    const db = makeDb({
      contacts: [
        { id: 'c-won', name: 'Ana', phone: '1', lead_temperature: 'hot', created_at: '2026-09-01' },
        { id: 'c-quoted', name: 'Beto', phone: '2', lead_temperature: 'warm', created_at: '2026-09-02' },
        { id: 'c-lead', name: 'Caro', phone: '3', lead_temperature: null, created_at: '2026-09-03' },
      ],
      conversations: [
        { contact_id: 'c-won', channel: 'whatsapp', assigned_agent_id: 'u1', last_message_at: '2026-09-05', created_at: '2026-09-01' },
        { contact_id: 'c-quoted', channel: 'instagram', assigned_agent_id: null, last_message_at: '2026-09-04', created_at: '2026-09-02' },
      ],
      quotes: [
        { contact_id: 'c-won', total: 1000, currency: 'GTQ', created_at: '2026-09-02' },
        { contact_id: 'c-quoted', total: 300, currency: 'GTQ', created_at: '2026-09-03' },
        { contact_id: 'c-quoted', total: 200, currency: 'GTQ', created_at: '2026-09-04' },
      ],
      deals: [
        { contact_id: 'c-won', title: 'Boda', value: 1000, currency: 'GTQ', status: 'won', assigned_to: 'u1', created_at: '2026-09-02', updated_at: '2026-09-06', pipeline_stages: { name: 'Venta cerrada' } },
      ],
      profiles: [{ user_id: 'u1', full_name: 'Vendedora Uno', email: null }],
    })
    const res = await exportEntity(db, 'acct-1', 'funnel')
    const byName = new Map(res.rows.slice(1).map((r) => [r[0], r]))
    const header = res.header
    const col = (name: string, field: string) => byName.get(name)![header.indexOf(field)]

    expect(res.rowCount).toBe(3)
    expect(col('Ana', 'Estado')).toBe('Ganado')
    expect(col('Ana', 'Etapa')).toBe('Venta cerrada')
    expect(col('Ana', 'Vendedor')).toBe('Vendedora Uno')
    expect(col('Ana', 'Última actividad')).toBe('2026-09-06')
    expect(col('Beto', 'Estado')).toBe('Cotizado')
    expect(col('Beto', '# Cotizaciones')).toBe(2)
    expect(col('Beto', 'Monto cotizado')).toBe(500)
    expect(col('Beto', 'Canal')).toBe('instagram')
    expect(col('Caro', 'Estado')).toBe('Lead')
    expect(col('Caro', '# Conversaciones')).toBe(0)
  })
})
