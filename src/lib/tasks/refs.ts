import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The task API writes through the service-role client, so RLS doesn't
 * stop a caller from pointing a task at another tenant's user, contact
 * or deal. That matters beyond tidiness: the reminder cron pushes the
 * task title + contact name to `assigned_to`, so an unchecked id would
 * leak one account's data to another. Every referenced id must belong to
 * `accountId` (null = "not set", always fine).
 */
export interface TaskRefs {
  assigned_to?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
}

/** Returns the first field that references something outside the account, or null. */
export async function findForeignTaskRef(
  db: SupabaseClient,
  accountId: string,
  refs: TaskRefs,
): Promise<keyof TaskRefs | null> {
  const checks: [keyof TaskRefs, string, string][] = [
    ['assigned_to', 'profiles', 'user_id'],
    ['contact_id', 'contacts', 'id'],
    ['deal_id', 'deals', 'id'],
  ];
  for (const [field, table, column] of checks) {
    const value = refs[field];
    if (!value) continue;
    const { data, error } = await db
      .from(table)
      .select(column)
      .eq(column, value)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return field;
  }
  return null;
}
