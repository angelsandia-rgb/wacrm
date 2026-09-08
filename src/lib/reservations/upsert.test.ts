import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const dispatch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: dispatch }))

import {
  upsertReservationRequest,
  categorySlugFromName,
  parseQuoteReservations,
} from './upsert'

describe('parseQuoteReservations', () => {
  it('maps a well-formed quote-builder entry, forcing source quote_builder', () => {
    const out = parseQuoteReservations([
      {
        category: 'habitaciones',
        product_id: 'p1',
        service_name: 'Suite',
        guests: '2',
        check_in: '2026-03-13',
        check_out: '2026-03-16',
        estimated_price: 2700,
      },
    ])
    expect(out).toEqual([
      {
        category: 'habitaciones',
        source: 'quote_builder',
        product_id: 'p1',
        service_name: 'Suite',
        guests: 2,
        check_in: '2026-03-13',
        check_out: '2026-03-16',
        estimated_price: 2700,
      },
    ])
  })

  it('drops entries with a bad / missing category and bad dates', () => {
    const out = parseQuoteReservations([
      { category: 'golf', guests: 2 },
      { service_name: 'no category' },
      { category: 'spa', check_in: 'nope', guests: -1 },
    ])
    expect(out).toEqual([{ category: 'spa', source: 'quote_builder' }])
  })

  it('returns [] for a non-array', () => {
    expect(parseQuoteReservations(undefined)).toEqual([])
    expect(parseQuoteReservations({})).toEqual([])
  })
})

describe('categorySlugFromName', () => {
  it('maps the hotel kit category names', () => {
    expect(categorySlugFromName('Habitaciones')).toBe('habitaciones')
    expect(categorySlugFromName('Spa')).toBe('spa')
    expect(categorySlugFromName('Actividades al aire libre')).toBe('actividades')
    expect(categorySlugFromName('Paquetes')).toBe('paquetes')
    expect(categorySlugFromName('Eventos')).toBe('eventos')
  })

  it('is fuzzy (renames / synonyms / other language)', () => {
    expect(categorySlugFromName('Rooms')).toBe('habitaciones')
    expect(categorySlugFromName('Tours y excursiones')).toBe('actividades')
    expect(categorySlugFromName('Salón de bodas')).toBe('eventos')
    expect(categorySlugFromName('Packages')).toBe('paquetes')
  })

  it('returns null for a non-hotel / empty / unknown category', () => {
    expect(categorySlugFromName(null)).toBeNull()
    expect(categorySlugFromName('')).toBeNull()
    expect(categorySlugFromName('Muebles')).toBeNull()
  })
})

beforeEach(() => dispatch.mockReset().mockResolvedValue(undefined))

/** Minimal admin-client stub. `existing` is what a `(conversation, category)`
 *  lookup returns; captures the insert/update payloads. `opts.readback` is
 *  the row `syncReservationToContactFields` re-reads by id; `opts.customFields`
 *  is the account's `custom_fields`. */
function makeAdmin(
  existing: { id: string } | null,
  opts: {
    readback?: Record<string, unknown> | null
    customFields?: { id: string; field_name: string }[]
  } = {},
) {
  const calls = {
    inserted: [] as Record<string, unknown>[],
    updated: [] as Record<string, unknown>[],
    customValueUpserts: [] as Record<string, unknown>[][],
  }
  const admin = {
    from(table: string) {
      if (table === 'reservation_requests') {
        return {
          select: () => ({
            // `(conversation, category)` lookup: .eq().eq().eq().maybeSingle()
            // Readback by id: .eq().maybeSingle()
            eq: () => ({
              eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: existing, error: null }) }) }),
              maybeSingle: () => Promise.resolve({ data: opts.readback ?? null, error: null }),
            }),
          }),
          update: (p: Record<string, unknown>) => {
            calls.updated.push(p)
            return { eq: () => Promise.resolve({ error: null }) }
          },
          insert: (p: Record<string, unknown>) => {
            calls.inserted.push(p)
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'new-id' }, error: null }) }) }
          },
        }
      }
      if (table === 'custom_fields') {
        return {
          select: () => ({ eq: () => Promise.resolve({ data: opts.customFields ?? [], error: null }) }),
        }
      }
      if (table === 'contact_custom_values') {
        return {
          upsert: (rows: Record<string, unknown>[]) => {
            calls.customValueUpserts.push(rows)
            return Promise.resolve({ error: null })
          },
        }
      }
      throw new Error('unexpected table ' + table)
    },
  } as unknown as SupabaseClient
  return { admin, calls }
}

describe('upsertReservationRequest', () => {
  it('inserts when there is no conversation match, then fires reservation.updated', async () => {
    const { admin, calls } = makeAdmin(null)
    const id = await upsertReservationRequest(admin, 'acct-1', {
      category: 'spa',
      service_name: 'Masaje',
      guests: 2,
      source: 'catalog',
    })
    expect(id).toBe('new-id')
    expect(calls.inserted[0]).toMatchObject({
      account_id: 'acct-1',
      category: 'spa',
      source: 'catalog',
      service_name: 'Masaje',
      guests: 2,
    })
    expect(dispatch).toHaveBeenCalledWith(admin, 'acct-1', 'reservation.updated', {
      reservation_id: 'new-id',
      source: 'catalog',
    })
  })

  it('extends an existing (conversation, category) row with only the provided fields', async () => {
    const { admin, calls } = makeAdmin({ id: 'r1' })
    const id = await upsertReservationRequest(admin, 'acct-1', {
      category: 'habitaciones',
      conversation_id: 'conv-1',
      guests: 3, // only this field this turn
    })
    expect(id).toBe('r1')
    expect(calls.inserted).toHaveLength(0)
    expect(calls.updated).toEqual([{ guests: 3, conversation_id: 'conv-1' }])
    expect(dispatch).toHaveBeenCalledWith(admin, 'acct-1', 'reservation.updated', {
      reservation_id: 'r1',
      source: 'manual',
    })
  })

  it('does not blank fields the caller omitted (undefined ≠ null)', async () => {
    const { admin, calls } = makeAdmin({ id: 'r1' })
    await upsertReservationRequest(admin, 'acct-1', {
      category: 'habitaciones',
      conversation_id: 'conv-1',
      check_in: '2026-03-13',
    })
    expect(calls.updated[0]).not.toHaveProperty('check_out')
    expect(calls.updated[0]).not.toHaveProperty('guests')
  })
})

describe('syncReservationToContactFields (via upsertReservationRequest)', () => {
  const HOTEL_FIELDS = [
    { id: 'f-in', field_name: 'Fecha de entrada' },
    { id: 'f-out', field_name: 'Fecha de salida' },
    { id: 'f-nights', field_name: 'Noches' },
    { id: 'f-room', field_name: 'Habitación' },
    { id: 'f-guests', field_name: 'Huéspedes' },
    { id: 'f-occ', field_name: 'Ocupación' },
    { id: 'f-pkg', field_name: 'Paquete' },
  ]

  it('derives Noches + fills the hotel contact fields for a room reservation', async () => {
    const { admin, calls } = makeAdmin(
      { id: 'r1' },
      {
        readback: {
          category: 'habitaciones',
          contact_id: 'contact-9',
          service_name: 'Suite Deluxe',
          guests: 2,
          check_in: '2026-03-13',
          check_out: '2026-03-16',
        },
        customFields: HOTEL_FIELDS,
      },
    )
    await upsertReservationRequest(admin, 'acct-1', {
      category: 'habitaciones',
      conversation_id: 'conv-1',
      guests: 2,
    })
    expect(calls.customValueUpserts).toHaveLength(1)
    const rows = calls.customValueUpserts[0]
    const byField = Object.fromEntries(rows.map((r) => [r.custom_field_id, r.value]))
    expect(byField).toEqual({
      'f-in': '2026-03-13',
      'f-out': '2026-03-16',
      'f-nights': '3',
      'f-room': 'Suite Deluxe',
      'f-guests': '2',
      'f-occ': 'Pareja',
    })
    expect(rows.every((r) => r.contact_id === 'contact-9')).toBe(true)
  })

  it('does nothing for a non-room category', async () => {
    const { admin, calls } = makeAdmin(
      { id: 'r1' },
      {
        readback: { category: 'spa', contact_id: 'contact-9', service_name: 'Masaje', guests: 1, check_in: null, check_out: null },
        customFields: HOTEL_FIELDS,
      },
    )
    await upsertReservationRequest(admin, 'acct-1', { category: 'spa', conversation_id: 'conv-1', guests: 1 })
    expect(calls.customValueUpserts).toHaveLength(0)
  })

  it('does nothing when the reservation has no contact', async () => {
    const { admin, calls } = makeAdmin(
      null,
      {
        readback: { category: 'habitaciones', contact_id: null, service_name: 'Suite', guests: 2, check_in: '2026-03-13', check_out: '2026-03-15' },
        customFields: HOTEL_FIELDS,
      },
    )
    await upsertReservationRequest(admin, 'acct-1', { category: 'habitaciones', source: 'catalog' })
    expect(calls.customValueUpserts).toHaveLength(0)
  })

  it('skips fields the account renamed / deleted (only writes the ones that still exist)', async () => {
    const { admin, calls } = makeAdmin(
      { id: 'r1' },
      {
        readback: {
          category: 'paquetes',
          contact_id: 'contact-9',
          service_name: 'Paquete Romántico',
          guests: 2,
          check_in: '2026-03-13',
          check_out: '2026-03-14',
        },
        customFields: [{ id: 'f-pkg', field_name: 'Paquete' }], // only this one remains
      },
    )
    await upsertReservationRequest(admin, 'acct-1', { category: 'paquetes', conversation_id: 'conv-1' })
    expect(calls.customValueUpserts[0]).toEqual([
      { contact_id: 'contact-9', custom_field_id: 'f-pkg', value: 'Paquete Romántico' },
    ])
  })
})
