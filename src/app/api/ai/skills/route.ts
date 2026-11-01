import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkSharedRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { normalizeSkills } from '@/lib/ai/skills'

/** GET /api/ai/skills — the account's AI skill switches and rules. */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase.from('ai_configs').select('skills').eq('account_id', accountId).maybeSingle()
    if (error) {
      console.error('[ai/skills GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load AI skills' }, { status: 500 })
    }
    return NextResponse.json({ configured: Boolean(data), skills: normalizeSkills(data?.skills) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST /api/ai/skills (admin+) — body { skills }. Needs the AI set up. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = await checkSharedRateLimit(`ai-skills:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const skills = normalizeSkills((body as { skills?: unknown }).skills)
    const { data, error } = await supabase
      .from('ai_configs')
      .update({ skills })
      .eq('account_id', accountId)
      .select('account_id')
      .maybeSingle()
    if (error) {
      console.error('[ai/skills POST] update error:', error)
      return NextResponse.json({ error: 'Failed to save AI skills' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Configura primero la IA (proveedor y clave).' }, { status: 400 })
    }
    return NextResponse.json({ success: true, skills })
  } catch (err) {
    return toErrorResponse(err)
  }
}
