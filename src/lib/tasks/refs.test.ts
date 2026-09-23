import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findForeignTaskRef } from './refs';

/** Rows owned by `acct-1`; anything else is another tenant's. */
const owned: Record<string, Record<string, string>> = {
  profiles: { 'user-mine': 'acct-1', 'user-theirs': 'acct-2' },
  contacts: { 'contact-mine': 'acct-1', 'contact-theirs': 'acct-2' },
  deals: { 'deal-mine': 'acct-1' },
};

function db(): SupabaseClient {
  return {
    from(table: string) {
      const filters: Record<string, string> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, value: string) => {
          filters[col] = value;
          return chain;
        },
        maybeSingle: async () => {
          const id = filters.user_id ?? filters.id;
          const match = owned[table]?.[id] === filters.account_id;
          return { data: match ? { id } : null, error: null };
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe('findForeignTaskRef', () => {
  it('accepts unset and same-account references', async () => {
    expect(await findForeignTaskRef(db(), 'acct-1', {})).toBeNull();
    expect(
      await findForeignTaskRef(db(), 'acct-1', {
        assigned_to: 'user-mine',
        contact_id: 'contact-mine',
        deal_id: 'deal-mine',
      }),
    ).toBeNull();
  });

  it('flags a user, contact or deal from another account', async () => {
    expect(await findForeignTaskRef(db(), 'acct-1', { assigned_to: 'user-theirs' })).toBe('assigned_to');
    expect(await findForeignTaskRef(db(), 'acct-1', { contact_id: 'contact-theirs' })).toBe('contact_id');
    expect(await findForeignTaskRef(db(), 'acct-1', { deal_id: 'deal-nope' })).toBe('deal_id');
  });
});
