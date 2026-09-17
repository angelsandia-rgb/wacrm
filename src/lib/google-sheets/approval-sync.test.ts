import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const H = vi.hoisted(() => ({
  from: vi.fn(),
  token: vi.fn(),
  getValues: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('./oauth', () => ({ getValidAccessToken: H.token }))
vi.mock('./api', () => ({ getValues: H.getValues }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: H.dispatch }))

import { syncReservationApprovals, matchApproval, columnLetter } from './approval-sync'

const ADMIN = { from: H.from } as unknown as SupabaseClient

/** Chainable query-builder stub: every select/filter method returns
 *  itself and it resolves (via `.then`, like the real supabase-js
 *  builder) to `result` when awaited. */
function chain(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    not: () => obj,
    limit: () => obj,
    update: () => obj,
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return obj
}

const CONNECTED_CONFIG = {
  account_id: 'acc-1',
  spreadsheet_id: 'sheet-1',
  sheet_tab: 'Villa San Ricardo',
  status: 'connected',
}

const HEADER_ROW = [
  ['Registrado', 'Habitación', 'Cliente', 'Contacto', 'Huéspedes', 'Check-in', 'Check-out', 'Precio estimado', 'Aprobación'],
]

beforeEach(() => {
  H.from.mockReset()
  H.token.mockReset().mockResolvedValue('tok')
  H.getValues.mockReset()
  H.dispatch.mockReset().mockResolvedValue(undefined)
})

describe('matchApproval', () => {
  it('matches common approved aliases case-insensitively', () => {
    expect(matchApproval('Aprobado')).toBe('approved')
    expect(matchApproval('  aprobada ')).toBe('approved')
    expect(matchApproval('SÍ')).toBe('approved')
  })

  it('matches common denied aliases', () => {
    expect(matchApproval('Negado')).toBe('denied')
    expect(matchApproval('rechazado')).toBe('denied')
    expect(matchApproval('no')).toBe('denied')
  })

  it('ignores blank, unrelated text, and non-strings', () => {
    expect(matchApproval('')).toBeNull()
    expect(matchApproval('   ')).toBeNull()
    expect(matchApproval('tal vez la próxima semana')).toBeNull()
    expect(matchApproval(null)).toBeNull()
    expect(matchApproval(42)).toBeNull()
  })
})

describe('columnLetter', () => {
  it('converts 0-based indices to A1 column letters', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(8)).toBe('I')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
  })
})

describe('syncReservationApprovals', () => {
  it('no-ops when no hotel account has a connected sheet', async () => {
    H.from.mockImplementation(() => chain({ data: [], error: null }))
    const res = await syncReservationApprovals(ADMIN)
    expect(res).toEqual({ accounts: 0, checked: 0, updated: 0, failed: 0 })
    expect(H.token).not.toHaveBeenCalled()
  })

  it('applies a recognized "Aprobado" cell to the matching pending reservation', async () => {
    let reservationCalls = 0
    H.from.mockImplementation((table: string) => {
      if (table === 'google_sheets_config') return chain({ data: [CONNECTED_CONFIG], error: null })
      if (table === 'reservation_requests') {
        reservationCalls++
        if (reservationCalls === 1) {
          return chain({
            data: [{ id: 'res-1', category: 'habitaciones', sheet_row: 5 }],
            error: null,
          })
        }
        return chain({ data: [{ id: 'res-1' }], error: null }) // the UPDATE
      }
      throw new Error('unexpected table ' + table)
    })
    H.getValues
      .mockResolvedValueOnce(HEADER_ROW) // header read
      .mockResolvedValueOnce([['Aprobado']]) // column read at row 5

    const res = await syncReservationApprovals(ADMIN)

    expect(res).toEqual({ accounts: 1, checked: 1, updated: 1, failed: 0 })
    expect(H.dispatch).toHaveBeenCalledWith(
      ADMIN,
      'acc-1',
      'reservation.updated',
      expect.objectContaining({ reservation_id: 'res-1', status_changed: true }),
    )
  })

  it('leaves a blank cell alone', async () => {
    H.from.mockImplementation((table: string) => {
      if (table === 'google_sheets_config') return chain({ data: [CONNECTED_CONFIG], error: null })
      return chain({ data: [{ id: 'res-1', category: 'habitaciones', sheet_row: 5 }], error: null })
    })
    H.getValues.mockResolvedValueOnce(HEADER_ROW).mockResolvedValueOnce([['']])

    const res = await syncReservationApprovals(ADMIN)

    expect(res.updated).toBe(0)
    expect(res.checked).toBe(1)
    expect(H.dispatch).not.toHaveBeenCalled()
  })

  it('skips a tab whose header has no "Aprobación" column', async () => {
    H.from.mockImplementation((table: string) => {
      if (table === 'google_sheets_config') return chain({ data: [CONNECTED_CONFIG], error: null })
      return chain({ data: [{ id: 'res-1', category: 'habitaciones', sheet_row: 5 }], error: null })
    })
    H.getValues.mockResolvedValueOnce([['Registrado', 'Habitación']]) // no Aprobación column

    const res = await syncReservationApprovals(ADMIN)

    expect(res.checked).toBe(0)
    expect(H.getValues).toHaveBeenCalledTimes(1) // never reads a column range
    expect(H.dispatch).not.toHaveBeenCalled()
  })

  it('does not double-count or dispatch when the update matches zero rows (lost the race to a CRM decision)', async () => {
    let reservationCalls = 0
    H.from.mockImplementation((table: string) => {
      if (table === 'google_sheets_config') return chain({ data: [CONNECTED_CONFIG], error: null })
      reservationCalls++
      if (reservationCalls === 1) {
        return chain({
          data: [{ id: 'res-1', category: 'habitaciones', sheet_row: 5 }],
          error: null,
        })
      }
      // Guarded update matched nothing — status already moved elsewhere.
      return chain({ data: [], error: null })
    })
    H.getValues.mockResolvedValueOnce(HEADER_ROW).mockResolvedValueOnce([['Aprobado']])

    const res = await syncReservationApprovals(ADMIN)

    expect(res.updated).toBe(0)
    expect(H.dispatch).not.toHaveBeenCalled()
  })
})
