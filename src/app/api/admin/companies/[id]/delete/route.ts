import { NextResponse } from 'next/server';
import { requirePlatformAdmin, toErrorResponse } from '@/lib/auth/account';
import { platformAdminClient } from '@/lib/platform/admin-client';

/**
 * POST /api/admin/companies/[id]/delete
 *
 * Platform-admin only. **Permanently deletes a company and everything
 * tied to it.** Irreversible.
 *
 * Body: `{ confirm_name: string }` — must match the company name exactly
 * (case-insensitive, trimmed), a typo guard against firing this by
 * accident.
 *
 * What it removes, in this order (the irreversible DB delete comes
 * before any best-effort cleanup, so a failed delete never leaves a live
 * company with its files already gone):
 *   1. Platform-level rows that only `SET NULL` on account delete
 *      (invitations, support tickets) — removed outright so no orphans
 *      linger in the admin panel.
 *   2. The `accounts` row — its `ON DELETE CASCADE` FKs then take out
 *      every tenant table (contacts, conversations, deals, products,
 *      flows, all `*_config`, `profiles`, …) in one statement.
 *   3. Storage objects under `account-<id>/` in every account-scoped
 *      bucket, plus each member's `avatars/<user_id>/` folder
 *      (best-effort — a bucket error is a warning, not fatal).
 *   4. Each member's `auth.users` account (not covered by the DB
 *      cascade). Failures are collected into `warnings`, not fatal.
 *
 * Refuses to delete the account the acting admin is signed in under.
 */

const ACCOUNT_SCOPED_BUCKETS = [
  'catalog-documents',
  'catalog-media',
  'chat-media',
  'clinic-files',
  'flow-media',
  'product-media',
];

/**
 * Remove every object directly under `prefix`. Always re-lists from the
 * start: removing a page shifts the listing, so advancing an offset would
 * skip every other page of files.
 */
async function removeFolder(
  admin: ReturnType<typeof platformAdminClient>,
  bucket: string,
  prefix: string,
  warnings: string[],
): Promise<void> {
  try {
    // Hard cap on passes so a remove that silently no-ops can't spin forever.
    for (let pass = 0; pass < 1000; pass++) {
      const { data: files, error } = await admin.storage
        .from(bucket)
        .list(prefix, { limit: 1000 });
      if (error) {
        warnings.push(`storage ${bucket}: ${error.message}`);
        return;
      }
      if (!files || files.length === 0) return;
      const { error: rmErr } = await admin.storage
        .from(bucket)
        .remove(files.map((f) => `${prefix}/${f.name}`));
      if (rmErr) {
        warnings.push(`storage ${bucket}: ${rmErr.message}`);
        return;
      }
    }
    warnings.push(`storage ${bucket}: ${prefix} not empty after cleanup`);
  } catch (err) {
    warnings.push(`storage ${bucket}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requirePlatformAdmin();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      confirm_name?: unknown;
    } | null;

    const admin = platformAdminClient();

    const { data: account, error: acctErr } = await admin
      .from('accounts')
      .select('id, name, owner_user_id')
      .eq('id', id)
      .maybeSingle();
    if (acctErr) throw acctErr;
    if (!account) {
      return NextResponse.json({ error: 'Empresa no encontrada' }, { status: 404 });
    }

    if (id === ctx.accountId) {
      return NextResponse.json(
        { error: 'No puedes eliminar la empresa desde la que administras la plataforma' },
        { status: 409 },
      );
    }

    const confirmName =
      body && typeof body.confirm_name === 'string' ? body.confirm_name.trim() : '';
    if (confirmName.toLowerCase() !== String(account.name).trim().toLowerCase()) {
      return NextResponse.json(
        { error: 'El nombre de confirmación no coincide con el de la empresa' },
        { status: 400 },
      );
    }

    const warnings: string[] = [];

    // Members whose auth accounts we must delete after the row cascade.
    // Must succeed: once the account row is gone, profiles cascade away
    // and there's no other record of who the members were.
    const { data: members, error: membersErr } = await admin
      .from('profiles')
      .select('user_id')
      .eq('account_id', id);
    if (membersErr) throw membersErr;
    const memberUserIds = new Set<string>(
      (members ?? []).map((m) => m.user_id as string).filter(Boolean),
    );
    if (account.owner_user_id) memberUserIds.add(account.owner_user_id as string);

    // 1. Platform-level rows that only SET NULL on account delete.
    for (const table of ['platform_company_invitations', 'support_tickets']) {
      const { error } = await admin.from(table).delete().eq('account_id', id);
      if (error) warnings.push(`${table}: ${error.message}`);
    }

    // 2. The account row — cascades every tenant table.
    const { error: delErr } = await admin.from('accounts').delete().eq('id', id);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }

    // 3. Storage — one prefixed folder per account per bucket, plus each
    //    member's avatar folder (avatars are keyed by user, not account).
    for (const bucket of ACCOUNT_SCOPED_BUCKETS) {
      await removeFolder(admin, bucket, `account-${id}`, warnings);
    }
    for (const userId of memberUserIds) {
      await removeFolder(admin, 'avatars', userId, warnings);
    }

    // 4. Member auth accounts (not covered by the DB cascade).
    let deletedMembers = 0;
    for (const userId of memberUserIds) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) warnings.push(`auth user ${userId}: ${error.message}`);
      else deletedMembers += 1;
    }

    return NextResponse.json({
      ok: true,
      deleted: { company: account.name, members: deletedMembers },
      warnings,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
