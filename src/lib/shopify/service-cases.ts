import type { SupabaseClient } from '@supabase/supabase-js'

/** SAC cases are plain tasks: owner = assignee, due = vencimiento, open/done =
 *  estado, completed_at = resolución. The title prefix marks them. */
// ponytail: title prefix instead of a tasks.kind column; add the column if other task kinds need filtering.
export const SERVICE_CASE_PREFIX = 'Atender chat: '
/** First human answer expected within this window; the task reminder cron
 *  pushes the owner at due time. */
// ponytail: wall-clock 4 h (a 1 a. m. case reminds at 5 a. m.); shift to business hours if it bothers.
export const SERVICE_CASE_DUE_MS = 4 * 3600_000
/** Still open this long after opening: escalated by the backlog check. */
export const SERVICE_CASE_ESCALATE_MS = 24 * 3600_000

/** Pure: task title — the customer's quoted words when the summary has them
 *  (buildHandoffSummary), else its first line. */
export function serviceCaseTitle(summary: string): string {
  const line = summary.match(/“([^”]+)”/)?.[1].trim()
    || summary.split('\n').map((l) => l.replace(/^🤖\s*/u, '').trim()).find(Boolean) || 'cliente derivado'
  return SERVICE_CASE_PREFIX + (line.length > 100 ? `${line.slice(0, 99)}…` : line)
}

/**
 * Connected stores only: every real (non-transient) handoff opens one SAC case
 * so it has an owner, a due time and a resolution. One open case per contact —
 * a second handoff in the same chat appends to it instead of opening another.
 * Never throws: the handoff itself already happened.
 */
export async function openServiceCase(db: SupabaseClient, args: {
  accountId: string; conversationId: string; summary: string; assigneeId: string | null; now?: Date
}): Promise<void> {
  const { accountId, conversationId, summary } = args
  const now = args.now ?? new Date()
  try {
    const { data: store } = await db.from('shopify_config').select('account_id').eq('account_id', accountId).maybeSingle()
    if (!store) return
    const { data: conv, error: convError } = await db.from('conversations').select('contact_id')
      .eq('id', conversationId).eq('account_id', accountId).maybeSingle()
    if (convError || !conv?.contact_id) return
    let owner = args.assigneeId
    if (!owner) {
      const { data: p } = await db.from('profiles').select('user_id').eq('account_id', accountId).eq('account_role', 'owner').limit(1).maybeSingle()
      owner = (p?.user_id as string | undefined) ?? null
    }
    if (!owner) return
    const { data: open } = await db.from('tasks').select('id, notes').eq('account_id', accountId)
      .eq('contact_id', conv.contact_id).eq('status', 'open').like('title', `${SERVICE_CASE_PREFIX}%`).limit(1).maybeSingle()
    if (open) {
      await db.from('tasks').update({ notes: `${open.notes ?? ''}\n\n— ${now.toISOString()}\n${summary}`.slice(-4000) }).eq('id', open.id)
      return
    }
    const { error } = await db.from('tasks').insert({
      account_id: accountId, created_by: owner, assigned_to: owner, contact_id: conv.contact_id,
      title: serviceCaseTitle(summary), notes: summary.slice(0, 4000),
      due_at: new Date(now.getTime() + SERVICE_CASE_DUE_MS).toISOString(),
    })
    if (error) console.error('[service case] insert failed:', error.message)
  } catch (err) {
    console.error('[service case] failed:', err instanceof Error ? err.message : err)
  }
}
