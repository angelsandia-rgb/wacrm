import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkSharedRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { resetConversationAiState } from '@/lib/conversations/reset-ai'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/conversations/[id]/reset-ai  (agent+)
 *
 * "Reset conversation for AI" — makes the bot forget everything said
 * so far in this thread and re-fires the account's `first_inbound_message`
 * automations (e.g. a configured welcome message), without touching the
 * visible chat history, the contact's data, or any reservation/deal.
 * See `resetConversationAiState` for exactly what's cleared.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Same bucket as the AI take-over/resume toggle: a cheap per-user
    // inbox action with no legitimate reason to be hammered in a loop.
    const limit = await checkSharedRateLimit(`ai-reset:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { id: conversationId } = await params

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[conversations/reset-ai] conversation lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('user_id', userId)
      .maybeSingle()
    const actorName = profile?.full_name || 'Un agente'

    await resetConversationAiState(supabase, { conversationId, accountId, actorName })

    // Best-effort — a welcome automation is a nice-to-have on top of the
    // reset that already happened; its own failure must not turn into a
    // 500 for an action that already committed successfully.
    if (conv.contact_id) {
      try {
        await runAutomationsForTrigger({
          accountId,
          triggerType: 'first_inbound_message',
          contactId: conv.contact_id,
          context: { conversation_id: conversationId },
        })
      } catch (err) {
        console.error('[conversations/reset-ai] welcome automation dispatch failed:', err)
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
