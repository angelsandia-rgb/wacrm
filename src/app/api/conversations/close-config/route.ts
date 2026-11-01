import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkSharedRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { DEFAULT_CLOSE_CATEGORIES, normalizeCloseConfig } from '@/lib/conversations/close-insights'

/**
 * GET /api/conversations/close-config — the account's close settings
 * (AI insights switch, categories, auto-close). Any member may read.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('conversation_close_config')
      .select('insights_enabled, categories, auto_close_after_days')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[close-config GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load close settings' }, { status: 500 })
    }
    return NextResponse.json(
      data ?? { insights_enabled: false, categories: DEFAULT_CLOSE_CATEGORIES, auto_close_after_days: null },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST /api/conversations/close-config (admin+) — upsert the settings. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = await checkSharedRateLimit(`close-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const normalized = normalizeCloseConfig(body as Record<string, unknown>)
    if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 })

    const { error } = await supabase.from('conversation_close_config').upsert(
      { account_id: accountId, created_by: userId, updated_at: new Date().toISOString(), ...normalized.value },
      { onConflict: 'account_id' },
    )
    if (error) {
      console.error('[close-config POST] upsert error:', error)
      return NextResponse.json({ error: 'Failed to save close settings' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
