import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/google-sheets/admin-client'
import { syncReservationApprovals } from '@/lib/google-sheets/approval-sync'
import { recordHeartbeat } from '@/lib/observability/heartbeat'
import { describeError } from '@/lib/observability/describe-error'

/**
 * Reads the hotel-filled "Aprobación" column back out of each connected
 * account's Google Sheet and applies a recognized decision to the
 * matching `reservation_requests.status` — the other direction from the
 * CRM's own Aprobar/Rechazar buttons (PATCH /api/reservations/[id]),
 * which already push CRM → Sheet on every explicit status change.
 *
 * Meant to be hit on a schedule (pg_cron — see migration 137) with the
 * `x-cron-secret` header matching RESERVATIONS_SYNC_CRON_SECRET, or
 * AUTOMATION_CRON_SECRET as a fallback so operators can reuse the
 * secret the automations/flows/followups jobs already use.
 */
export async function GET(request: Request) {
  const expected =
    process.env.RESERVATIONS_SYNC_CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await syncReservationApprovals(supabaseAdmin())
    await recordHeartbeat('reservation_approval_sync_cron', {
      detail: `accounts ${result.accounts}, checked ${result.checked}, updated ${result.updated}, failed ${result.failed}`,
    })
    return NextResponse.json(result)
  } catch (err) {
    const message = describeError(err)
    console.error('[reservations-approval-sync/cron] sync failed:', message)
    await recordHeartbeat('reservation_approval_sync_cron', { status: 'error', detail: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
