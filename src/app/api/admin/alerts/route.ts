import { NextResponse } from "next/server";
import { requirePlatformAdmin, toErrorResponse } from "@/lib/auth/account";
import { platformAdminClient } from "@/lib/platform/admin-client";

/**
 * GET /api/admin/alerts  (platform admin only)
 *
 * Lists rows from `system_alerts` (migration 088), the sink
 * `dispatchSystemAlert()` writes to, newest-seen first. Defaults to
 * only unresolved alerts, matching the mental model of the panel
 * (what needs attention right now) — pass ?resolved=1 to also see
 * closed ones. Same service-role read pattern as GET
 * /api/admin/tickets: no new RLS policy needed, `system_alerts`
 * already has one restricting SELECT to `is_platform_admin()`.
 *
 * Each alert is embedded with its `system_alert_watcher_runs` (migration
 * 134) — what the hourly "SANDIA alert watcher" cloud routine found when
 * it investigated: a PR it opened, a diagnosis-only note, or nothing yet.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformAdmin();
    const admin = platformAdminClient();
    const includeResolved =
      new URL(request.url).searchParams.get("resolved") === "1";

    let query = admin
      .from("system_alerts")
      .select(
        "id, severity, source, title, detail, dedup_key, account_id, account:accounts(name), first_seen_at, last_seen_at, occurrences, notified_at, resolved_at, " +
          "watcher_runs:system_alert_watcher_runs(id, status, branch, pr_url, summary, tests_passed, merged_at, created_at)",
      )
      .order("last_seen_at", { ascending: false })
      .limit(200);

    if (!includeResolved) {
      query = query.is("resolved_at", null);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ alerts: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}
