import type { SupabaseClient } from '@supabase/supabase-js'
import {
  answeredConversationCount,
  csatSummary,
  briefCompletionPercent,
  conversationFirstTimes,
  handoffsAdvancedCount,
  medianFirstResponseMinutes,
  recoveredConversationCount,
  temperatureDistribution,
} from './compute'
import type {
  ContactExportRow,
  CsatRow,
  DateWindow,
  KpiDataset,
  LeadRow,
  SpendEntry,
  TrialMetrics,
  WonDealRow,
} from './types'
import type { BucketGranularity } from '@/lib/dashboard/date-utils'
import { fetchAllRows, fetchAllRowsIn } from '@/lib/supabase/fetch-all'

type DB = SupabaseClient

// Same "client-side aggregation, RLS scopes it automatically" contract
// as src/lib/dashboard/queries.ts — no account_id filters needed here.
// Every row-set read goes through `fetchAllRows` so an aggregate is never
// computed from a set PostgREST silently capped at `max_rows`.

/** Every contact created within `window` — the shared row set behind
 *  "leads generados", "leads calificados" and their time series (see
 *  src/lib/kpis/compute.ts). One query, several derived metrics. */
export async function loadLeadsInWindow(db: DB, window: DateWindow): Promise<LeadRow[]> {
  return fetchAllRows<LeadRow>(
    () =>
      db
        .from('contacts')
        .select('id, created_at, lead_temperature')
        .gte('created_at', window.start.toISOString())
        .lt('created_at', endExclusive(window.end)),
    { label: 'kpis leads' },
  )
}

/** Just the count — used for the previous-period comparison, where we
 *  don't need the full rows. */
export async function countLeadsInWindow(db: DB, window: DateWindow): Promise<number> {
  const { count, error } = await db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', window.start.toISOString())
    .lt('created_at', endExclusive(window.end))
  if (error) throw error
  return count ?? 0
}

/** Every deal that became won within `window` — the shared row set
 *  behind "tasa de conversión", the sales funnel, and CAC. Filters on
 *  `won_at` (migration 064); falls back to `updated_at` only for a
 *  legacy row that predates the backfill (shouldn't happen, but the
 *  OR keeps a stray null from silently vanishing from every chart). */
export async function loadWonDealsInWindow(db: DB, window: DateWindow): Promise<WonDealRow[]> {
  return fetchAllRows<WonDealRow>(
    () =>
      db
        .from('deals')
        .select('id, won_at, updated_at, value, currency')
        .eq('status', 'won')
        .or(
          `and(won_at.gte.${window.start.toISOString()},won_at.lt.${endExclusive(window.end)}),` +
            `and(won_at.is.null,updated_at.gte.${window.start.toISOString()},updated_at.lt.${endExclusive(window.end)})`,
        ),
    { label: 'kpis won deals' },
  )
}

export async function countWonDealsInWindow(db: DB, window: DateWindow): Promise<number> {
  const rows = await loadWonDealsInWindow(db, window)
  return rows.length
}

/** Every post-sale CSAT survey created within `window` — the row set
 *  behind the satisfaction KPI card. RLS scopes it to the account. */
export async function loadCsatInWindow(db: DB, window: DateWindow): Promise<CsatRow[]> {
  return fetchAllRows<CsatRow & { id: string }>(
    () =>
      db
        .from('csat_surveys')
        .select('id, created_at, status, score, scale')
        .gte('created_at', window.start.toISOString())
        .lt('created_at', endExclusive(window.end)),
    { label: 'kpis csat' },
  )
}

/** Every saved spend entry, oldest first — feeds the CAC-history
 *  chart. Small table (one row per period an admin bothered to log),
 *  no pagination needed. */
export async function loadSpendHistory(db: DB): Promise<SpendEntry[]> {
  const { data, error } = await db
    .from('kpi_period_spend')
    .select('id, period_start, period_end, amount, currency')
    .order('period_start', { ascending: true })
  if (error) throw error
  return (data ?? []) as SpendEntry[]
}

/** The spend entry for exactly this window, if one was already saved
 *  (pre-fills the input instead of showing blank on a revisit). */
export async function loadSpendForWindow(db: DB, window: DateWindow): Promise<SpendEntry | null> {
  const { data, error } = await db
    .from('kpi_period_spend')
    .select('id, period_start, period_end, amount, currency')
    .eq('period_start', dateOnly(window.start))
    .eq('period_end', dateOnly(window.end))
    .maybeSingle()
  if (error) throw error
  return (data as SpendEntry | null) ?? null
}

/** Upserts the spend figure for `window` — re-saving the same window
 *  updates in place (UNIQUE(account_id, period_start, period_end)). */
export async function saveSpendForWindow(
  db: DB,
  accountId: string,
  userId: string,
  window: DateWindow,
  amount: number,
  currency: string,
): Promise<void> {
  const { error } = await db.from('kpi_period_spend').upsert(
    {
      account_id: accountId,
      period_start: dateOnly(window.start),
      period_end: dateOnly(window.end),
      amount,
      currency,
      created_by: userId,
    },
    { onConflict: 'account_id,period_start,period_end' },
  )
  if (error) throw error
}

/** Every contact created during `window`, with the fields the
 *  "Contacts" export sheet needs — name, phone, derived channel, all
 *  their notes, and their most recent deal's stage. Three queries
 *  (contacts, then notes + deals in parallel, keyed by contact id)
 *  instead of one deep join: notes/deals are one-to-many, and a
 *  Supabase embedded-join would multiply the contact row per note or
 *  deal instead of collapsing it back down. Only called on export
 *  click, never for the on-screen KPIs, so the extra round-trips
 *  don't cost anything on page load. */
export async function loadContactExportRows(db: DB, window: DateWindow): Promise<ContactExportRow[]> {
  type Row = { id: string; created_at: string } & Record<string, unknown>
  const byCreatedAt = (a: Row, b: Row) => a.created_at.localeCompare(b.created_at)
  const contacts = (
    await fetchAllRows<Row>(
      () =>
        db
          .from('contacts')
          .select('id, name, phone, instagram_id, instagram_username, facebook_id, facebook_username, created_at')
          .gte('created_at', window.start.toISOString())
          .lt('created_at', endExclusive(window.end)),
      { label: 'kpis contact export' },
    )
  ).sort(byCreatedAt)
  if (contacts.length === 0) return []

  const ids = contacts.map((c) => c.id)
  const [notes, deals] = await Promise.all([
    fetchAllRowsIn<Row>(ids, (chunk) =>
      db.from('contact_notes').select('id, contact_id, note_text, created_at').in('contact_id', chunk),
    ),
    fetchAllRowsIn<Row>(ids, (chunk) =>
      db.from('deals').select('id, contact_id, created_at, stage:pipeline_stages(name)').in('contact_id', chunk),
    ),
  ])
  notes.sort(byCreatedAt)
  deals.sort((a, b) => byCreatedAt(b, a))

  const notesByContact = new Map<string, string[]>()
  for (const n of notes) {
    const row = n as Record<string, unknown>
    const contactId = row.contact_id as string
    const arr = notesByContact.get(contactId) ?? []
    arr.push(row.note_text as string)
    notesByContact.set(contactId, arr)
  }

  // Deals came back newest-first, so the first hit per contact is
  // their most recent — later ones for the same contact are ignored.
  const stageByContact = new Map<string, string>()
  for (const d of deals) {
    const row = d as Record<string, unknown>
    const contactId = row.contact_id as string
    if (stageByContact.has(contactId)) continue
    const stage = row.stage as { name?: string } | null
    if (stage?.name) stageByContact.set(contactId, stage.name)
  }

  return contacts.map((c) => {
    const row = c as Record<string, unknown>
    const channel: ContactExportRow['channel'] = row.instagram_id
      ? 'instagram'
      : row.facebook_id
        ? 'facebook'
        : 'whatsapp'
    return {
      id: row.id as string,
      name: (row.name || row.instagram_username || row.facebook_username || row.phone || '') as string,
      phone: (row.phone as string | null) ?? null,
      channel,
      createdAt: row.created_at as string,
      notes: (notesByContact.get(row.id as string) ?? []).join(' | '),
      stage: stageByContact.get(row.id as string) ?? null,
    }
  })
}

/**
 * The operational "trial" metrics (see TrialMetrics). Bounded by the
 * window: everything is measured over messages / nudges / handoffs
 * that happened inside it, not "entities created in it". `leadIds` is
 * passed in (already loaded by `loadKpiDataset`) so brief-completion
 * doesn't re-query contacts.
 */
export async function loadTrialMetrics(
  db: DB,
  window: DateWindow,
  previousWindow: DateWindow,
  leadIds: string[],
): Promise<TrialMetrics> {
  const winStartIso = window.start.toISOString()
  const winEndExcl = endExclusive(window.end)

  type MsgRow = { id: string; conversation_id: string; sender_type: string; created_at: string }
  type FollowupRow = { id: string; conversation_id: string; sent_at: string; error: string | null }
  type HandoffRow = { id: string; contact_id: string | null; ai_handoff_at: string }
  const [allMsgs, allFollowups, handoffs] = await Promise.all([
    // One contiguous fetch spanning both windows (previousWindow ends
    // right before window starts) — split in JS by `winStartIso`.
    // Sorted by time: first-response pairing walks each conversation
    // chronologically, and pages arrive in `id` order.
    fetchAllRows<MsgRow>(
      () =>
        db
          .from('messages')
          .select('id, conversation_id, sender_type, created_at')
          .gte('created_at', previousWindow.start.toISOString())
          .lt('created_at', winEndExcl),
      { label: 'kpis trial messages', maxRows: 200_000 },
    ).then((rows) => rows.sort((a, b) => a.created_at.localeCompare(b.created_at))),
    fetchAllRows<FollowupRow>(
      () =>
        db
          .from('ai_followup_log')
          .select('id, conversation_id, sent_at, error')
          .gte('sent_at', previousWindow.start.toISOString())
          .lt('sent_at', winEndExcl),
      { label: 'kpis trial follow-ups' },
    ),
    fetchAllRows<HandoffRow>(
      () =>
        db
          .from('conversations')
          .select('id, contact_id, ai_handoff_at')
          .not('ai_handoff_at', 'is', null)
          .gte('ai_handoff_at', winStartIso)
          .lt('ai_handoff_at', winEndExcl),
      { label: 'kpis trial handoffs' },
    ),
  ])

  const curMsgs = allMsgs.filter((m) => m.created_at >= winStartIso)
  const prevMsgs = allMsgs.filter((m) => m.created_at < winStartIso)

  const curTimes = conversationFirstTimes(curMsgs)
  const prevTimes = conversationFirstTimes(prevMsgs)

  const curFollowups = allFollowups.filter((f) => f.sent_at >= winStartIso && !f.error)
  const prevFollowups = allFollowups.filter((f) => f.sent_at < winStartIso && !f.error)

  const curCustomerMsgs = curMsgs
    .filter((m) => m.sender_type === 'customer')
    .map((m) => ({ conversation_id: m.conversation_id, created_at: m.created_at }))

  let handoffsAdvanced = 0
  const handoffContactIds = [...new Set(handoffs.map((h) => h.contact_id).filter((x): x is string => !!x))]
  if (handoffContactIds.length > 0) {
    const deals = await fetchAllRowsIn<{
      id: string
      contact_id: string
      status: string
      won_at: string | null
      updated_at: string
    }>(handoffContactIds, (chunk) =>
      db.from('deals').select('id, contact_id, status, won_at, updated_at').in('contact_id', chunk),
    )
    handoffsAdvanced = handoffsAdvancedCount(handoffs, deals)
  }

  // Brief completion — any custom value at all marks the lead's brief as
  // started. Chunked + paged: a lead set can carry many values each.
  const customValues = await fetchAllRowsIn<{ id: string; contact_id: string }>(leadIds, (chunk) =>
    db.from('contact_custom_values').select('id, contact_id').in('contact_id', chunk),
  )
  const withValues = new Set(customValues.map((row) => row.contact_id))

  return {
    conversationsActive: curTimes.size,
    conversationsAnswered: answeredConversationCount(curTimes),
    medianFirstResponseMin: medianFirstResponseMinutes(curTimes),
    prevMedianFirstResponseMin: medianFirstResponseMinutes(prevTimes),
    followupsSent: curFollowups.length,
    prevFollowupsSent: prevFollowups.length,
    opportunitiesRecovered: recoveredConversationCount(
      curFollowups.map((f) => ({ conversation_id: f.conversation_id, sent_at: f.sent_at })),
      curCustomerMsgs,
    ),
    handoffs: handoffs.length,
    handoffsAdvanced,
    briefCompletionPct: briefCompletionPercent(leadIds, withValues),
  }
}

/**
 * Fetches everything the KPIs page needs for one render in a single
 * batch — the page component's only query entry point. Individual
 * `load*`/`count*` functions above stay exported for direct reuse
 * (e.g. a future "just the funnel" widget) and unit-friendliness.
 */
export async function loadKpiDataset(
  db: DB,
  window: DateWindow,
  previousWindow: DateWindow,
  granularity: BucketGranularity,
): Promise<KpiDataset> {
  const [
    leads,
    previousLeadsCount,
    wonDeals,
    previousWonCount,
    spendHistory,
    currentPeriodSpend,
    csatRows,
  ] = await Promise.all([
    loadLeadsInWindow(db, window),
    countLeadsInWindow(db, previousWindow),
    loadWonDealsInWindow(db, window),
    countWonDealsInWindow(db, previousWindow),
    loadSpendHistory(db),
    loadSpendForWindow(db, window),
    loadCsatInWindow(db, window),
  ])

  // Needs the lead ids from the batch above, so it runs after.
  const trial = await loadTrialMetrics(
    db,
    window,
    previousWindow,
    leads.map((l) => l.id),
  )

  return {
    granularity,
    window,
    previousWindow,
    leads,
    previousLeadsCount,
    wonDeals,
    previousWonCount,
    temperature: temperatureDistribution(leads),
    spendHistory,
    currentPeriodSpend,
    trial,
    csat: csatSummary(csatRows),
  }
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** `window.end` is inclusive by convention everywhere in this module
 *  (matches how the KPIs page's date pickers work — "last 30 days"
 *  includes today) — Postgres range queries need an exclusive upper
 *  bound, so every `.lt(...)` call uses this: midnight the day AFTER
 *  `end`. */
function endExclusive(end: Date): string {
  const out = new Date(end)
  out.setHours(0, 0, 0, 0)
  out.setDate(out.getDate() + 1)
  return out.toISOString()
}
