// ============================================================
// Recover customer messages whose AI reply was lost.
//
// The auto-reply runs in the background of the webhook request and first
// waits a ~20s quiet period (debounce.ts) in memory. If the container is
// restarted inside that window — every deploy does it — the pending reply
// dies with the process and the customer gets silence. Real incident
// 2026-09-24 (Villa San Ricardo): a "hola" arrived one second before a
// deploy swapped the container and was never answered.
//
// This sweep (run from the conversations cron) finds open conversations
// whose LAST message is a customer text that has sat unanswered for a few
// minutes — long past any legitimate in-flight reply (debounce + a
// provider call + one retry is ~2 minutes) — and re-runs the normal AI
// dispatch once per message. The dispatch re-checks every eligibility
// rule itself (auto-reply off, assigned to a human, handed off, reply
// cap), so a conversation the bot should stay out of stays silent.
// Each message is attempted at most once (ai_action_log claim).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchInboundToAiReply } from './auto-reply'

const MIN_AGE_MS = 4 * 60_000
/** Older than this, a late automatic reply would read as odd — leave it
 *  to a human. */
const MAX_AGE_MS = 60 * 60_000
const MAX_PER_RUN = 20

export interface InboundRecoveryResult {
  scanned: number
  recovered: number
}

interface ConversationRow {
  id: string
  account_id: string
  contact_id: string | null
  last_message_at: string
}

export async function recoverUnansweredInbound(
  db: SupabaseClient,
  opts: {
    now?: number
    dispatch?: typeof dispatchInboundToAiReply
  } = {},
): Promise<InboundRecoveryResult> {
  const now = opts.now ?? Date.now()
  const dispatch = opts.dispatch ?? dispatchInboundToAiReply

  const { data, error } = await db
    .from('conversations')
    .select('id, account_id, contact_id, last_message_at')
    .eq('status', 'open')
    .is('assigned_agent_id', null)
    .gte('last_message_at', new Date(now - MAX_AGE_MS).toISOString())
    .lte('last_message_at', new Date(now - MIN_AGE_MS).toISOString())
    .order('last_message_at', { ascending: true })
    .limit(MAX_PER_RUN * 3)
  if (error) throw error

  const result: InboundRecoveryResult = { scanned: 0, recovered: 0 }
  for (const conv of (data ?? []) as ConversationRow[]) {
    if (result.recovered >= MAX_PER_RUN) break
    if (!conv.contact_id) continue
    result.scanned++

    // The customer's latest message must be a plain text — the only
    // inbound the webhooks hand to the AI (interactive replies and media
    // go elsewhere).
    const { data: lastCustomer } = await db
      .from('messages')
      .select('id, sender_type, content_type, created_at')
      .eq('conversation_id', conv.id)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const msg = lastCustomer as { id: string; sender_type: string; content_type: string; created_at: string } | null
    if (!msg || msg.content_type !== 'text') continue

    // Answered = some TEXT we sent after it. Images alone don't count: the
    // hotel bot sends the banner/photos BEFORE its text, so a restart
    // between the two left a thread whose last message is our photo and
    // no reply at all — and this sweep skipped it as "answered" (test run
    // 2026-09-24, prueba #27, killed by a deploy mid-reply).
    const { data: repliesAfter } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conv.id)
      .in('sender_type', ['bot', 'agent'])
      .eq('content_type', 'text')
      .gt('created_at', msg.created_at)
      .limit(1)
    if (repliesAfter && repliesAfter.length > 0) continue
    const age = now - Date.parse(msg.created_at)
    if (age < MIN_AGE_MS || age > MAX_AGE_MS) continue

    // A flow owns the conversation (still active) or touched it after this
    // message (advanced or ended): the flow consumed it — flows win over
    // the AI — so it isn't "unanswered".
    const since = new Date(msg.created_at).toISOString()
    const { count: flowTouches, error: flowError } = await db
      .from('flow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv.id)
      .or(`status.eq.active,last_advanced_at.gte.${since},ended_at.gte.${since}`)
    if (flowError || (flowTouches ?? 0) > 0) continue

    // Claim this message once — a later sweep (or an overlapping one)
    // must never re-dispatch it.
    const { data: prior } = await db
      .from('ai_action_log')
      .select('id')
      .eq('account_id', conv.account_id)
      .eq('action', 'inbound_recovery')
      .eq('target_id', conv.id)
      .eq('input->>message_id', msg.id)
      .limit(1)
    if (prior && prior.length > 0) continue

    const { data: account } = await db
      .from('accounts')
      .select('owner_user_id')
      .eq('id', conv.account_id)
      .maybeSingle()
    const ownerId = (account as { owner_user_id?: string | null } | null)?.owner_user_id
    if (!ownerId) continue

    const { error: claimError } = await db.from('ai_action_log').insert({
      account_id: conv.account_id,
      actor_user_id: ownerId,
      action: 'inbound_recovery',
      target_id: conv.id,
      input: { message_id: msg.id, age_seconds: Math.round(age / 1000) },
      result: { conversation_id: conv.id },
    })
    if (claimError) {
      console.error('[inbound-recovery] claim failed, skipping', conv.id, claimError.message)
      continue
    }

    await dispatch({
      accountId: conv.account_id,
      conversationId: conv.id,
      contactId: conv.contact_id,
      configOwnerUserId: ownerId,
      skipDebounce: true,
    })
    result.recovered++
  }
  return result
}
