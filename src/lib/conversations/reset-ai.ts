import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Reset a conversation's AI memory back to zero: end any active flow
 * for this thread, clear every handoff/pause/reply-count column the
 * bot's eligibility gate reads, drop any undecided hotel reservation
 * drafts for this thread, and set `ai_context_reset_at` so
 * `buildConversationContext` stops feeding pre-reset messages to the
 * model. The visible chat history and all DECIDED business data
 * (approved reservations, contact fields, lead temperature) are
 * untouched.
 *
 * The `reservation_requests` cleanup exists because
 * `handOffIfReservationComplete` (auto-reply.ts) re-checks the
 * conversation's current active-build row for whatever category the
 * guest is asking about on EVERY turn, regardless of how old that row
 * is — a stale `pending` row left over from days-old testing in the
 * same thread (verified live, 2026-09-18, DEMO account) has every
 * required field already filled and triggers an immediate, silent
 * hand-off on the very next question about that category, even though
 * the just-reset conversation never supplied any of that data. A
 * `denied` row carries the same risk (that check has no status
 * filter). A row survives the reset when EITHER a human already
 * decided it (`status = 'approved'`) OR the GUEST already explicitly
 * confirmed it (`guest_confirmed_at` set — see
 * `handOffIfReservationComplete`) and staff simply hasn't reviewed it
 * yet. `status` alone used to be the only check here, which was wrong:
 * a guest confirming a booking never changes `status` (only a human
 * clicking approve/deny in the inbox does), so it stays `pending`
 * indefinitely — real incident, 2026-09-23 (7-case live QA run, DEMO
 * account): 6 of 7 guest-confirmed test reservations in the same
 * thread were silently deleted by the reset done before starting the
 * next case, even though this function's own reset dialog promises
 * "cualquier reservación o negocio no se ven afectados". Only a row
 * NOBODY ever confirmed — neither the guest nor staff — is truly an
 * abandoned draft safe to clear.
 *
 * Lives here rather than inline in the route so it can be tested
 * without standing up `requireRole`.
 */
export async function resetConversationAiState(
  db: SupabaseClient,
  args: { conversationId: string; accountId: string; actorName: string },
): Promise<{ flowRunsEnded: number; reservationDraftsCleared: number }> {
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

  // Best-effort, same reasoning as flow_runs above. Never a row a
  // human already approved, or one the GUEST already explicitly
  // confirmed — see the doc comment.
  const { data: clearedDrafts, error: reqErr } = await db
    .from('reservation_requests')
    .delete()
    .eq('conversation_id', args.conversationId)
    .neq('status', 'approved')
    .is('guest_confirmed_at', null)
    .select('id')
  if (reqErr) {
    console.error('[reset-ai] failed to clear reservation drafts:', reqErr)
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

  return {
    flowRunsEnded: (endedRuns ?? []).length,
    reservationDraftsCleared: (clearedDrafts ?? []).length,
  }
}
