import { NextResponse } from "next/server";
import { requirePlatformAdmin, toErrorResponse } from "@/lib/auth/account";
import { platformAdminClient } from "@/lib/platform/admin-client";

/**
 * POST /api/admin/alerts/[id]/resolve  (platform admin only)
 *
 * Manually closes one alert row. `resolveSystemAlert()` in
 * src/lib/observability/alerts.ts takes a `dedupKey`, not a row id —
 * rather than fetch the row first to recover its dedup_key just to
 * call that helper, update `resolved_at` directly by id (the same
 * effect: a later recurrence of the same dedup_key re-opens a fresh
 * row and re-notifies, since the partial unique index only covers
 * unresolved rows).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const admin = platformAdminClient();

    const { data, error } = await admin
      .from("system_alerts")
      .update({ resolved_at: new Date().toISOString() })
      .eq("id", id)
      .is("resolved_at", null)
      .select("id, resolved_at")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { error: "Alerta no encontrada o ya resuelta" },
        { status: 404 },
      );
    }

    return NextResponse.json({ alert: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
