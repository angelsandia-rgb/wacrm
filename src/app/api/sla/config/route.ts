import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkSharedRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { normalizeSlaConfig, SLA_DEFAULTS } from '@/lib/sla/config'

const COLS = 'enabled, alert_minutes, escalate_minutes, ai_ack_minutes, ack_text, window_start_hour, window_end_hour'

/** GET /api/sla/config — the account's response-time target. Any member may read. */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase.from('response_sla_config').select(COLS).eq('account_id', accountId).maybeSingle()
    if (error) {
      console.error('[sla/config GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load response-time settings' }, { status: 500 })
    }
    return NextResponse.json(data ?? SLA_DEFAULTS)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST /api/sla/config (admin+) — upsert the settings. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = await checkSharedRateLimit(`sla-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const normalized = normalizeSlaConfig(body as Record<string, unknown>)
    if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 })

    const { error } = await supabase.from('response_sla_config').upsert(
      { account_id: accountId, created_by: userId, updated_at: new Date().toISOString(), ...normalized.value },
      { onConflict: 'account_id' },
    )
    if (error) {
      console.error('[sla/config POST] upsert error:', error)
      return NextResponse.json({ error: 'Failed to save response-time settings' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
