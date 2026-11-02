import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/google-sheets/admin-client'
import { computeDailySummary } from '@/lib/google-sheets/daily-summary'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { recordHeartbeat } from '@/lib/observability/heartbeat'

/**
 * GET /api/google-sheets/daily-summary/cron — once a day (migration 176).
 * For every account whose connected Sheet has the `daily.summary` event
 * on, computes yesterday's totals (account timezone) and dispatches the
 * event: the Sheet gets a `<base> - Resumen diario` row and any webhook
 * subscribed to it gets the same payload. `x-cron-secret`, falling back
 * to SUBSCRIPTIONS_CRON_SECRET like the weekly-health cron.
 */
export async function GET(request: Request) {
  const expected = process.env.SHEETS_SUMMARY_CRON_SECRET || process.env.SUBSCRIPTIONS_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const expectedBuf = Buffer.from(expected)
  if (supplied.length !== expectedBuf.length || !timingSafeEqual(supplied, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const { data: configs, error } = await db
    .from('google_sheets_config')
    .select('account_id, accounts(timezone)')
    .eq('status', 'connected')
    .contains('events', ['daily.summary'])
  if (error) {
    await recordHeartbeat('sheets_daily_summary_cron', { status: 'error', detail: error.message })
    return NextResponse.json({ error: 'config lookup failed' }, { status: 500 })
  }

  let sent = 0
  let failed = 0
  for (const c of configs ?? []) {
    const account = Array.isArray(c.accounts) ? c.accounts[0] : c.accounts
    const timeZone = (account as { timezone?: string | null } | null)?.timezone?.trim() || 'America/Guatemala'
    try {
      const summary = await computeDailySummary(db, c.account_id as string, timeZone)
      await dispatchWebhookEvent(db, c.account_id as string, 'daily.summary', summary)
      sent++
    } catch (err) {
      failed++
      console.error('[sheets/daily-summary] account failed:', c.account_id, err)
    }
  }

  await recordHeartbeat('sheets_daily_summary_cron', {
    status: failed > 0 && sent === 0 ? 'error' : 'ok',
    detail: `sent ${sent}, failed ${failed}`,
  })
  return NextResponse.json({ sent, failed })
}
