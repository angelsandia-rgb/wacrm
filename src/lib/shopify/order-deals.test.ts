import { describe, expect, it } from 'vitest'
import { attachOrderToDeal } from './api'

interface Deal { id: string; account_id: string; contact_id: string; stage_id: string; status: string; shopify_order_id: string | null; shopify_confirmation_decision: string | null }
function database(decision: string | null, previousId: string | null = 'old', insertFailure?: { message: string; code?: string }) {
  const rows: Deal[] = [{ id: 'previous', account_id: 'a', contact_id: 'c', stage_id: 'placed', status: 'open', shopify_order_id: previousId, shopify_confirmation_decision: decision }]
  const db = { from(table: string) {
    const filters: [string, unknown][] = []
    let update: Record<string, unknown> | undefined
    let insert: Record<string, unknown> | undefined
    const execute = () => {
      if (table === 'pipelines') return [{ id: 'p', name: 'Pedidos' }]
      if (table === 'pipeline_stages') return [{ id: 'placed', name: 'Pedido creado' }]
      if (insert) {
        const row = { ...insert, id: `new-${rows.length}` } as unknown as Deal
        rows.push(row)
        return [row]
      }
      const matched = rows.filter((row) => filters.every(([key, value]) => row[key as keyof Deal] === value))
      if (update) matched.forEach((row) => Object.assign(row, update))
      return matched
    }
    const c = {
      select: () => c, order: () => c, limit: () => c,
      eq: (k: string, v: unknown) => { filters.push([k, v]); return c },
      is: (k: string, v: unknown) => { filters.push([k, v]); return c },
      update: (fields: Record<string, unknown>) => { update = fields; return c },
      insert: (fields: Record<string, unknown>) => { insert = fields; return c },
      maybeSingle: async () => ({ data: execute()[0] ?? null, error: null }),
      single: async () => {
        if (insertFailure) {
          // A concurrent winner is visible to the next account-scoped lookup.
          if (insertFailure.code === '23505') execute()
          return { data: null, error: insertFailure }
        }
        return { data: execute()[0] ?? null, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: execute(), error: null }),
    }
    return c
  } }
  const attach = (id = 'new', accountId = 'a') => attachOrderToDeal({ db: db as never, accountId, userId: 'u', contactId: 'c', currency: 'GTQ', order: { id, name: '#1006', total: 300 } })
  return { rows, attach }
}

describe('a contact making another Shopify order', () => {
  it.each(['confirm', 'cancel'])('preserves the previous %s and gives the new order its own undecided deal', async (decision) => {
    const { rows, attach } = database(decision)
    expect(await attach()).not.toBe('previous')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ shopify_order_id: 'old', shopify_confirmation_decision: decision })
    expect(rows[1]).toMatchObject({ shopify_order_id: 'new', shopify_confirmation_decision: null })
  })
  it('does not overwrite an earlier order which has not been answered yet', async () => {
    const { rows, attach } = database(null)
    await attach()
    expect(rows).toHaveLength(2)
    expect(rows[0].shopify_order_id).toBe('old')
  })
  it('reuses a deal for a repeated event without clearing its customer decision', async () => {
    const { rows, attach } = database('confirm')
    expect(await attach('old')).toBe('previous')
    expect(rows).toHaveLength(1)
    expect(rows[0].shopify_confirmation_decision).toBe('confirm')
  })
  it('can link an unassigned lead and clears any stale decision for the new order', async () => {
    const { rows, attach } = database('cancel', null)
    expect(await attach()).toBe('previous')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ shopify_order_id: 'new', shopify_confirmation_decision: null })
  })
  it('never adopts another account’s matching order', async () => {
    const { rows, attach } = database('confirm')
    expect(await attach('old', 'b')).not.toBe('previous')
    expect(rows[1].account_id).toBe('b')
    expect(rows[0].shopify_confirmation_decision).toBe('confirm')
  })
  it('propagates persistence failures instead of losing the order behind a success response', async () => {
    const { rows, attach } = database(null, 'old', { message: 'database unavailable' })
    await expect(attach()).rejects.toThrow('Cannot create order deal: database unavailable')
    expect(rows).toHaveLength(1)
  })
  it('recovers the same order after a concurrent unique-index winner', async () => {
    const { rows, attach } = database(null, 'old', { message: 'duplicate key', code: '23505' })
    expect(await attach()).toBe('new-1')
    expect(rows).toHaveLength(2)
    expect(rows[1].shopify_order_id).toBe('new')
  })
})
