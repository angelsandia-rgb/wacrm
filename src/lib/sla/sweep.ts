// ============================================================
// Response-time target — the sweep (run by /api/conversations/cron,
// every ~5 min). For each account that turned it on (response_sla_config),
// finds open WhatsApp conversations whose customer is waiting, and fires
// the due stages once each:
//   alert    → notify the assignee; nobody assigned → assign the
//              least-loaded online teammate (the assignment trigger pushes)
//   escalate → reassign to the least-loaded online teammate other than the
//              current one (equitable); nobody else online → notify everyone
//   ai_ack   → one safe acknowledgement from the bot, only when the AI may
//              talk to that contact and the 24 h window is open
// Each stage is claimed by inserting its response_sla_events row first, so
// overlapping ticks can't double-fire.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { contactMutesAi } from '@/lib/ai/muted-contact'
import { isWithinMessagingWindow } from '@/lib/messaging/window'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { leastLoaded, loadAssignableAgents, loadOpenAssignedCounts } from '@/lib/conversations/reassign'
import { dueStages, isNonCustomerTag, unansweredSince, waitingMinutes, type SlaConfig, type SlaStage } from './clock'

const MAX_CONVERSATIONS_PER_ACCOUNT = 200
const MESSAGES_PER_CONVERSATION = 30

interface ConfigRow extends SlaConfig {
  account_id: string
  ack_text: string
}

interface ConvRow {
  id: string
  contact_id: string | null
  assigned_agent_id: string | null
}

export interface SlaSweepResult {
  accounts: number
  waiting: number
  fired: Record<SlaStage, number>
}

export async function runResponseSlaSweep(db: SupabaseClient, now: Date = new Date()): Promise<SlaSweepResult> {
  const res: SlaSweepResult = { accounts: 0, waiting: 0, fired: { alert: 0, escalate: 0, ai_ack: 0 } }
  const { data: configs, error } = await db
    .from('response_sla_config')
    .select('account_id, alert_minutes, escalate_minutes, ai_ack_minutes, ack_text, window_start_hour, window_end_hour')
    .eq('enabled', true)
  if (error) throw new Error(`sla: config read failed: ${error.message}`)

  for (const cfg of (configs ?? []) as ConfigRow[]) {
    const { data: account } = await db.from('accounts').select('timezone').eq('id', cfg.account_id).maybeSingle()
    const tz = (account?.timezone as string | null) || 'America/Guatemala'
    // Outside the daily window: no notices at all this tick.
    if (waitingMinutes(now.toISOString(), now, tz, cfg.window_start_hour, cfg.window_end_hour) === null) continue
    res.accounts++

    const { data: convs } = await db
      .from('conversations')
      .select('id, contact_id, assigned_agent_id')
      .eq('account_id', cfg.account_id)
      .eq('status', 'open')
      .eq('channel', 'whatsapp')
      .or(`snoozed_until.is.null,snoozed_until.lt.${now.toISOString()}`)
      .gte('last_message_at', new Date(now.getTime() - 24 * 3_600_000).toISOString())
      .lte('last_message_at', new Date(now.getTime() - cfg.alert_minutes * 60_000).toISOString())
      .limit(MAX_CONVERSATIONS_PER_ACCOUNT)

    for (const conv of (convs ?? []) as ConvRow[]) {
      try {
        await handleConversation(db, cfg, tz, conv, now, res)
      } catch (err) {
        console.error('[sla] conversation failed', conv.id, err instanceof Error ? err.message : err)
      }
    }
  }
  return res
}

async function handleConversation(
  db: SupabaseClient, cfg: ConfigRow, tz: string, conv: ConvRow, now: Date, res: SlaSweepResult,
): Promise<void> {
  const { data: msgs } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(MESSAGES_PER_CONVERSATION)
  const since = unansweredSince(msgs ?? [])
  if (!since) return
  const waited = waitingMinutes(since, now, tz, cfg.window_start_hour, cfg.window_end_hour)
  if (waited === null || waited < cfg.alert_minutes) return

  const tagNames = await contactTagNames(db, conv.contact_id)
  if (tagNames.some(isNonCustomerTag)) return
  res.waiting++

  const { data: done } = await db
    .from('response_sla_events')
    .select('stage')
    .eq('conversation_id', conv.id)
    .eq('since_customer_at', since)
  const stages = dueStages(waited, cfg, new Set((done ?? []).map((d) => d.stage as SlaStage)))
  if (!stages.length) return

  const name = await contactName(db, cfg.account_id, conv.contact_id)
  for (const stage of stages) {
    // Claim first: a concurrent tick that loses the insert does nothing.
    const { data: claim, error } = await db
      .from('response_sla_events')
      .insert({ account_id: cfg.account_id, conversation_id: conv.id, since_customer_at: since, stage })
      .select('id')
      .maybeSingle()
    if (error || !claim) continue
    const outcome = await act(db, cfg, conv, stage, name, waited)
    await db.from('response_sla_events').update({ target_user_id: outcome.target, error: outcome.error }).eq('id', claim.id)
    if (!outcome.error) res.fired[stage]++
  }
}

async function act(
  db: SupabaseClient, cfg: ConfigRow, conv: ConvRow, stage: SlaStage, name: string, waited: number,
): Promise<{ target: string | null; error: string | null }> {
  const accountId = cfg.account_id
  if (stage === 'ai_ack') {
    if (await contactMutesAi(db, conv.contact_id, accountId)) return { target: null, error: 'ai_muted_for_contact' }
    if (!(await isWithinMessagingWindow(db, conv.id))) return { target: null, error: 'outside_24h_window' }
    try {
      await sendMessageToConversation(db, accountId, {
        conversationId: conv.id, messageType: 'text', contentText: cfg.ack_text, senderType: 'bot',
      })
      return { target: null, error: null }
    } catch (err) {
      return { target: null, error: err instanceof Error ? err.message.slice(0, 300) : 'send_failed' }
    }
  }

  const everyone = await loadAssignableAgents(db, accountId, { onlineOnly: false })
  const online = await loadAssignableAgents(db, accountId, { onlineOnly: true })
  const title = stage === 'alert' ? 'Cliente esperando respuesta' : 'Cliente sin respuesta: se reasignó'

  if (stage === 'alert' && conv.assigned_agent_id) {
    await notify(db, accountId, [conv.assigned_agent_id], conv, 'Cliente esperando respuesta', `${name} lleva ${waited} min sin respuesta.`)
    return { target: conv.assigned_agent_id, error: null }
  }

  // alert with nobody assigned, or escalate: the least-loaded online teammate
  // other than the current one takes it (the assignment trigger pushes them).
  const candidates = online.filter((id) => id !== conv.assigned_agent_id)
  if (candidates.length) {
    const pick = leastLoaded(candidates, await loadOpenAssignedCounts(db, accountId, candidates))!
    let q = db.from('conversations').update({ assigned_agent_id: pick }).eq('id', conv.id).eq('account_id', accountId)
    q = conv.assigned_agent_id ? q.eq('assigned_agent_id', conv.assigned_agent_id) : q.is('assigned_agent_id', null)
    const { data: moved } = await q.select('id').maybeSingle()
    if (moved) {
      await notify(db, accountId, [pick], conv, title, `${name} lleva ${waited} min sin respuesta. Se le asignó a usted.`)
      return { target: pick, error: null }
    }
  }
  // Nobody (else) online: tell the whole team — their phones get the push.
  await notify(db, accountId, everyone, conv, title, `${name} lleva ${waited} min sin respuesta y no hay otro asesor en línea.`)
  return { target: null, error: null }
}

async function notify(db: SupabaseClient, accountId: string, userIds: string[], conv: ConvRow, title: string, body: string) {
  if (!userIds.length) return
  const { error } = await db.from('notifications').insert(userIds.map((user_id) => ({
    account_id: accountId, user_id, type: 'response_sla', conversation_id: conv.id, contact_id: conv.contact_id, title, body,
  })))
  if (error) console.error('[sla] notification insert failed:', error.message)
}

async function contactTagNames(db: SupabaseClient, contactId: string | null): Promise<string[]> {
  if (!contactId) return []
  const { data } = await db.from('contact_tags').select('tags(name)').eq('contact_id', contactId)
  return (data ?? []).flatMap((row) => {
    const tags = (row as { tags?: { name?: string } | { name?: string }[] | null }).tags
    return (Array.isArray(tags) ? tags : [tags]).map((t) => t?.name ?? '')
  })
}

async function contactName(db: SupabaseClient, accountId: string, contactId: string | null): Promise<string> {
  if (!contactId) return 'Un cliente'
  const { data } = await db.from('contacts').select('name, phone').eq('id', contactId).eq('account_id', accountId).maybeSingle()
  return (data?.name as string | null) || (data?.phone as string | null) || 'Un cliente'
}
