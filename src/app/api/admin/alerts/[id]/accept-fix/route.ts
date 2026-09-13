import { NextResponse } from "next/server";
import { requirePlatformAdmin, toErrorResponse } from "@/lib/auth/account";
import { platformAdminClient } from "@/lib/platform/admin-client";
import { GithubMergeError, mergePullRequest } from "@/lib/github/merge-pr";

/**
 * POST /api/admin/alerts/[id]/accept-fix  (platform admin only)
 *
 * "Aceptar" on a watcher-proposed fix: fetches the most recent
 * `system_alert_watcher_runs` row for this alert with an open PR,
 * merges it via the GitHub API (mergePullRequest — squash), and
 * stamps `merged_at`. EasyPanel auto-deploys `main` on push, so this
 * one click is the whole "accept and ship" step for a fix that
 * doesn't also carry a new Supabase migration (those still need a
 * human to apply by hand — the watcher calls that out in the PR body).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const admin = platformAdminClient();

    const { data: run, error } = await admin
      .from("system_alert_watcher_runs")
      .select("id, pr_url, merged_at")
      .eq("alert_id", id)
      .eq("status", "pr_opened")
      .not("pr_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!run || !run.pr_url) {
      return NextResponse.json(
        { error: "No hay un PR propuesto por el watcher para esta alerta" },
        { status: 404 },
      );
    }
    if (run.merged_at) {
      return NextResponse.json(
        { error: "Ese PR ya fue aceptado desde este panel" },
        { status: 409 },
      );
    }

    const { sha } = await mergePullRequest(run.pr_url);

    await admin
      .from("system_alert_watcher_runs")
      .update({ merged_at: new Date().toISOString() })
      .eq("id", run.id);

    return NextResponse.json({ merged: true, sha, pr_url: run.pr_url });
  } catch (error) {
    if (error instanceof GithubMergeError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return toErrorResponse(error);
  }
}
