import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { platformAdminClient } from '@/lib/platform/admin-client';
import { sendPushToUser } from '@/lib/push/send';

/**
 * POST /api/system/alert-watcher/notify   { title?: string, message: string }
 *
 * The "SANDIA alert watcher" cloud routine has no phone of its own — the
 * Claude Code `PushNotification` tool only reaches a device when Remote
 * Control is paired to *that* session, which an ephemeral cloud routine
 * run never is, so calls to it there are silently undeliverable. This
 * endpoint is how the routine actually reaches a platform admin's
 * phone: it's a thin wrapper around the same `sendPushToUser` Web Push
 * plumbing `sendCriticalPush` already uses in src/lib/observability/alerts.ts.
 *
 * Auth: shared secret via `x-watcher-secret` header, same pattern as
 * `AUTOMATION_CRON_SECRET` on the cron routes — this isn't a cron (no
 * scheduling here), just a machine caller outside a user session, so a
 * platform-admin session isn't available to gate on.
 */
export async function POST(request: Request) {
  const expected = process.env.ALERT_WATCHER_NOTIFY_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-watcher-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { title?: unknown; message?: unknown }
    | null;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }
  const title =
    typeof body?.title === 'string' && body.title.trim()
      ? body.title.trim()
      : '🤖 SANDIA alert watcher';

  const db = platformAdminClient();
  const { data: admins } = await db
    .from('profiles')
    .select('user_id')
    .eq('is_platform_admin', true);

  if (!admins || admins.length === 0) {
    return NextResponse.json({ sent: 0 });
  }

  const results = await Promise.allSettled(
    admins.map((admin) =>
      sendPushToUser(db, admin.user_id as string, {
        title,
        body: message.slice(0, 300),
        url: '/admin#alerts',
      }),
    ),
  );
  const sent = results.reduce(
    (n, r) => n + (r.status === 'fulfilled' ? r.value.sent : 0),
    0,
  );

  return NextResponse.json({ sent });
}
