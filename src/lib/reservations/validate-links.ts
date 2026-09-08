import type { SupabaseClient } from '@supabase/supabase-js'

const TABLES = {
  contact_id: 'contacts',
  conversation_id: 'conversations',
  product_id: 'products',
  quote_id: 'quotes',
} as const

/** Service-role writes bypass RLS; every supplied foreign key needs its own scope. */
export async function reservationLinksBelongToAccount(
  db: SupabaseClient,
  accountId: string,
  input: object,
): Promise<boolean> {
  const values = input as Record<string, unknown>
  const results = await Promise.all(Object.entries(TABLES).map(async ([key, table]) => {
    const id = values[key]
    if (id == null) return true
    if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return false
    const { data, error } = await db.from(table).select('id').eq('id', id)
      .eq('account_id', accountId).maybeSingle()
    return !error && !!data
  }))
  return results.every(Boolean)
}
