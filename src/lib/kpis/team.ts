import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, fetchAllRowsIn } from '@/lib/supabase/fetch-all'
import type { DateWindow } from './types'

// ============================================================
// Team report (respond.io parity): a per-pipeline stage funnel and a
// per-agent leaderboard. Same contract as queries.ts — browser client,
// RLS scopes every read to the account.
// ============================================================

export interface FunnelStageCount {
  id: string
  name: string
  color: string | null
  /** Deals of the cohort that reached this stage or a later one. */
  reached: number
}

export interface PipelineFunnel {
  pipelineId: string
  name: string
  /** Deals created in the window. */
  total: number
  won: number
  lost: number
  stages: FunnelStageCount[]
}

export interface AgentStat {
  userId: string
  name: string
  /** Open conversations assigned right now. */
  openAssigned: number
  /** Assigned conversations closed in the window. */
  closed: number
  /** Messages the agent sent from the inbox in the window. */
  replies: number
  /** Median minutes from a waiting customer message to this agent's reply. */
  medianResponseMin: number | null
  wonDeals: number
  wonValue: number
}

export interface TeamReport {
  funnels: PipelineFunnel[]
  agents: AgentStat[]
}

type Stage = { id: string; pipeline_id: string; name: string; position: number; color: string | null }
type Deal = { id: string; pipeline_id: string; stage_id: string | null; status: string }

/** Cohort funnel: a deal "reached" every stage up to its current one
 *  (by position); a won deal reached them all. No stage history exists,
 *  so a deal moved backwards counts only up to where it sits now. */
export function pipelineFunnels(
  pipelines: { id: string; name: string }[],
  stages: Stage[],
  deals: Deal[],
): PipelineFunnel[] {
  return pipelines
    .map((p) => {
      const own = stages.filter((s) => s.pipeline_id === p.id).sort((a, b) => a.position - b.position)
      const index = new Map(own.map((s, i) => [s.id, i]))
      const cohort = deals.filter((d) => d.pipeline_id === p.id)
      const depth = cohort.map((d) => (d.status === 'won' ? own.length - 1 : (index.get(d.stage_id ?? '') ?? 0)))
      return {
        pipelineId: p.id,
        name: p.name,
        total: cohort.length,
        won: cohort.filter((d) => d.status === 'won').length,
        lost: cohort.filter((d) => d.status === 'lost').length,
        stages: own.map((s, i) => ({
          id: s.id,
          name: s.name,
          color: s.color,
          reached: depth.filter((x) => x >= i).length,
        })),
      }
    })
    .filter((f) => f.total > 0)
}

type Msg = { conversation_id: string; sender_type: string; sender_id: string | null; created_at: string }

/** Per-agent response minutes: the first customer message still waiting
 *  for an answer → the next outbound. Credited only when that outbound
 *  was a teammate's inbox send (sender_id set); a bot reply just clears
 *  the wait. `msgs` must be sorted by created_at. */
export function agentResponseMinutes(msgs: Msg[]): Map<string, number[]> {
  const waiting = new Map<string, string>()
  const out = new Map<string, number[]>()
  for (const m of msgs) {
    if (m.sender_type === 'customer') {
      if (!waiting.has(m.conversation_id)) waiting.set(m.conversation_id, m.created_at)
      continue
    }
    const since = waiting.get(m.conversation_id)
    waiting.delete(m.conversation_id)
    if (!since || !m.sender_id) continue
    const min = (Date.parse(m.created_at) - Date.parse(since)) / 60_000
    out.set(m.sender_id, [...(out.get(m.sender_id) ?? []), min])
  }
  return out
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export async function loadTeamReport(db: SupabaseClient, window: DateWindow): Promise<TeamReport> {
  const startIso = window.start.toISOString()
  const end = new Date(window.end)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)
  const endIso = end.toISOString()

  const [pipelines, stages, deals, members, openConvs, closedConvs, agentMsgs, wonDeals] = await Promise.all([
    fetchAllRows<{ id: string; name: string }>(() => db.from('pipelines').select('id, name'), { label: 'team pipelines' }),
    fetchAllRows<Stage>(() => db.from('pipeline_stages').select('id, pipeline_id, name, position, color'), {
      label: 'team stages',
    }),
    fetchAllRows<Deal>(
      () =>
        db.from('deals').select('id, pipeline_id, stage_id, status').gte('created_at', startIso).lt('created_at', endIso),
      { label: 'team deals' },
    ),
    fetchAllRows<{ id: string; user_id: string; full_name: string | null; email: string | null }>(
      () => db.from('profiles').select('id, user_id, full_name, email').in('account_role', ['owner', 'admin', 'agent']),
      { label: 'team members' },
    ),
    fetchAllRows<{ id: string; assigned_agent_id: string }>(
      () => db.from('conversations').select('id, assigned_agent_id').eq('status', 'open').not('assigned_agent_id', 'is', null),
      { label: 'team open conversations' },
    ),
    fetchAllRows<{ id: string; assigned_agent_id: string }>(
      () =>
        db
          .from('conversations')
          .select('id, assigned_agent_id')
          .not('assigned_agent_id', 'is', null)
          .gte('closed_at', startIso)
          .lt('closed_at', endIso),
      { label: 'team closed conversations' },
    ),
    fetchAllRows<{ id: string; conversation_id: string }>(
      () =>
        db
          .from('messages')
          .select('id, conversation_id')
          .not('sender_id', 'is', null)
          .gte('created_at', startIso)
          .lt('created_at', endIso),
      { label: 'team agent messages' },
    ),
    fetchAllRows<{ id: string; assigned_to: string | null; value: number | null }>(
      () =>
        db
          .from('deals')
          .select('id, assigned_to, value')
          .eq('status', 'won')
          .not('assigned_to', 'is', null)
          .gte('won_at', startIso)
          .lt('won_at', endIso),
      { label: 'team won deals' },
    ),
  ])

  // Full message sequence of the conversations agents answered, so each
  // reply can be paired with the customer message it answered.
  const convIds = [...new Set(agentMsgs.map((m) => m.conversation_id))]
  const thread = (
    await fetchAllRowsIn<Msg & { id: string }>(convIds, (chunk) =>
      db
        .from('messages')
        .select('id, conversation_id, sender_type, sender_id, created_at')
        .in('conversation_id', chunk)
        .gte('created_at', startIso)
        .lt('created_at', endIso),
    )
  ).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const responses = agentResponseMinutes(thread)

  const count = <T>(rows: T[], key: (r: T) => string | null) => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const k = key(r)
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }
  const open = count(openConvs, (c) => c.assigned_agent_id)
  const closed = count(closedConvs, (c) => c.assigned_agent_id)
  const replies = count(
    thread.filter((m) => m.sender_id),
    (m) => m.sender_id,
  )
  // deals.assigned_to points at profiles.id, everything else at user_id.
  const userByProfile = new Map(members.map((p) => [p.id, p.user_id]))
  const won = new Map<string, { n: number; value: number }>()
  for (const d of wonDeals) {
    const uid = userByProfile.get(d.assigned_to ?? '')
    if (!uid) continue
    const cur = won.get(uid) ?? { n: 0, value: 0 }
    won.set(uid, { n: cur.n + 1, value: cur.value + (d.value ?? 0) })
  }

  const agents = members
    .map<AgentStat>((p) => ({
      userId: p.user_id,
      name: p.full_name || p.email || '—',
      openAssigned: open.get(p.user_id) ?? 0,
      closed: closed.get(p.user_id) ?? 0,
      replies: replies.get(p.user_id) ?? 0,
      medianResponseMin: median(responses.get(p.user_id) ?? []),
      wonDeals: won.get(p.user_id)?.n ?? 0,
      wonValue: won.get(p.user_id)?.value ?? 0,
    }))
    .sort((a, b) => b.closed - a.closed || b.replies - a.replies || a.name.localeCompare(b.name))

  return { funnels: pipelineFunnels(pipelines, stages, deals), agents }
}
