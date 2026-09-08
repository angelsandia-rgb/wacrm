import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reservationLinksBelongToAccount } from './validate-links'

const id = '00000000-0000-0000-0000-000000000001'
function db(owner: string, error: object | null = null) {
  return { from: () => ({ select: () => ({ eq: () => ({
    eq: (key: string, account: string) => ({ maybeSingle: async () => ({
      data: key === 'account_id' && account === owner ? { id } : null, error,
    }) }),
  }) }) }) } as unknown as SupabaseClient
}

describe('reservation tenant references', () => {
  for (const field of ['contact_id', 'conversation_id', 'product_id', 'quote_id']) {
    it(`rejects a foreign ${field} and accepts an owned reference`, async () => {
      expect(await reservationLinksBelongToAccount(db('other'), 'own', { [field]: id })).toBe(false)
      expect(await reservationLinksBelongToAccount(db('own'), 'own', { [field]: id })).toBe(true)
    })
  }
  it('fails closed on database errors and malformed references', async () => {
    expect(await reservationLinksBelongToAccount(db('own', {}), 'own', { contact_id: id })).toBe(false)
    expect(await reservationLinksBelongToAccount(db('own'), 'own', { product_id: {} })).toBe(false)
    expect(await reservationLinksBelongToAccount(db('own'), 'own', { product_id: null })).toBe(true)
  })
})
