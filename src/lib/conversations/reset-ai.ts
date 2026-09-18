import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Reset a conversation's AI memory back to zero: end any active flow
 * for this thread, clear every handoff/pause/reply-count column the
 * bot's eligibility gate reads, and set `ai_context_reset_at` so
 * `buildConversationContext` stops feeding pre-reset messages to the
 * model. The visible chat history and all real business data
 * (reservations, contact fields, lead temperature) are untouched.
 *
 * Lives here rather than inline in the route so it can be tested
 * without standing up `requireRole`.
 */
export async function resetConversationAiState(
  db: SupabaseClient,
  args: { conversationId: string; accountId: string; actorName: string },
): Promise<{ flowRunsEnded: number }> {
  const nowIso = new Date().toISOString()

  // Best-effort: a flow that failed to end must not block the rest of
  // the reset (the conversation-level update below is what actually
  // stops the bot from seeing stale context/handoff state).
  const { data: endedRuns, error: flowErr } = await db
    .from('flow_runs')
    .update({ status: 'paused_by_agent', ended_at: nowIso, end_reason: 'reset_by_agent' })
    .eq('conversation_id', args.conversationId)
    .eq('status', 'active')
    .select('id')
  if (flowErr) {
    console.error('[reset-ai] failed to end active flow run(s):', flowErr)
  }

  const { error: convErr } = await db
    .from('conversations')
    .update({
      ai_autoreply_disabled: false,
      assigned_agent_id: null,
      ai_reply_count: 0,
      ai_handoff_at: null,
      ai_handoff_transient: null,
      ai_flow_directive: null,
      ai_handoff_summary: null,
      ai_context_reset_at: nowIso,
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
  if (convErr) throw convErr

  // Best-effort audit trail, same pattern as the take-over/resume note
  // in /api/ai/autoreply — never block the reset itself on this.
  const { error: noteError } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'internal_note',
    content_text: `🔄 ${args.actorName} reinició la memoria de la IA en esta conversación.`,
    status: 'sent',
  })
  if (noteError) {
    console.error('[reset-ai] failed to insert internal note:', noteError)
  }

  return { flowRunsEnded: (endedRuns ?? []).length }
}
