import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { runClinicReminderSweep } from '@/lib/clinic/reminders-sweep'
import { recordHeartbeat } from '@/lib/observability/heartbeat'

/**
 * Clinic appointment confirmations + visit follow-ups. Hit on a
 * schedule (pg_cron — see migration 126) with `x-cron-secret` matching
 * `CLINIC_REMINDERS_CRON_SECRET`, or `AUTOMATION_CRON_SECRET` as a
 * fallback so the operator can reuse the secret the other cron jobs
 * already use.
 *
 * Concurrent invocations use renewable database claims (migration 129).
 * Delivered stamps are written only after the channel accepts the send;
 * a crashed worker can be reclaimed after the lease expires.
 */
export async function GET(request: Request) {
  const expected =
    process.env.CLINIC_REMINDERS_CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runClinicReminderSweep(supabaseAdmin())
    await recordHeartbeat('clinic_reminders_cron', {
      detail: `confirm ${result.confirmationsSent}, no-response ${result.noResponseFlagged}, follow-up ${result.followupsSent}, failed ${result.failed}`,
    })
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[clinic/reminders/cron] sweep failed:', message)
    await recordHeartbeat('clinic_reminders_cron', { status: 'error', detail: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
