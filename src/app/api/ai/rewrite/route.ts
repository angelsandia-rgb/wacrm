import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkSharedRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'
import { buildRewritePrompt, cleanRewrite, isRewriteAction, MAX_REWRITE_CHARS } from '@/lib/ai/rewrite'

/**
 * POST /api/ai/rewrite  (agent+)
 *
 * Body: { text, action } — action is one of REWRITE_ACTIONS.
 * Returns: { text } — the agent's draft rewritten (tone, grammar,
 * simplify, translate). Read-only; same BYO key and rate limits as
 * /api/ai/draft.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const userLimit = await checkSharedRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = await checkSharedRateLimit(`ai-draft-acct:${accountId}`, RATE_LIMITS.aiDraftAccount)
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const text = body && typeof body.text === 'string' ? body.text.trim() : ''
    const action = body?.action
    if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 })
    if (text.length > MAX_REWRITE_CHARS) {
      return NextResponse.json({ error: 'text is too long' }, { status: 400 })
    }
    if (!isRewriteAction(action)) return NextResponse.json({ error: 'unknown action' }, { status: 400 })

    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      console.error('[ai/rewrite] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', { code: 'key_decrypt_failed', status: 400 })
    })
    if (!config) {
      return NextResponse.json(
        { error: 'AI assistant is not set up. Enable it in Settings → AI Assistant.', code: 'ai_not_configured' },
        { status: 400 },
      )
    }

    const { text: raw, usage } = await generateReply({
      config,
      systemPrompt: buildRewritePrompt(action),
      messages: [{ role: 'user', content: text }],
    })
    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId: null,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
      })
    } catch (logErr) {
      console.error('[ai/rewrite] usage log skipped:', logErr)
    }

    const rewritten = cleanRewrite(raw)
    if (!rewritten) return NextResponse.json({ error: 'The assistant returned nothing.' }, { status: 502 })
    return NextResponse.json({ text: rewritten })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
