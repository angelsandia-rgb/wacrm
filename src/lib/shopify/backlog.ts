import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/currency'
import { dispatchSystemAlert, resolveSystemAlert } from '@/lib/observability/alerts'
import { enqueueOrderNotification } from './notification-jobs'
import { REQUEST_TTL_MS, requestSummary } from './order-requests'

/** A "sí" being placed takes seconds; this long means the worker died mid-way. */
const STUCK_PROCESSING_MS = 15 * 60_000
/** A notice still undelivered after this long (or this many tries) needs a person. */
const STUCK_JOB_MS = 2 * 3600_000
const STUCK_JOB_ATTEMPTS = 8

interface JobRow { account_id: string; event_key: string; attempts: number; created_at: string; last_error: string | null }
interface RequestRow { id: string; account_id: string; decided_at: string | null }

/** Pure: per account, what is stuck. Deliberate waits (business hours, cart
 *  inactivity) are not stuck — they say so in last_error. */
export function stuckByAccount(requests: RequestRow[], jobs: JobRow[], now: Date): Map<string, { requests: string[]; jobs: { key: string; error: string | null }[] }> {
  const out = new Map<string, { requests: string[]; jobs: { key: string; error: string | null }[] }>()
  const entry = (id: string) => out.get(id) ?? out.set(id, { requests: [], jobs: [] }).get(id)!
  for (const r of requests) {
    if (now.getTime() - Date.parse(r.decided_at ?? '') >= STUCK_PROCESSING_MS) entry(r.account_id).requests.push(r.id)
  }
  for (const j of jobs) {
    if (j.last_error?.startsWith('Waiting for')) continue
    if (now.getTime() - Date.parse(j.created_at) >= STUCK_JOB_MS || j.attempts >= STUCK_JOB_ATTEMPTS) {
      entry(j.account_id).jobs.push({ key: j.event_key, error: j.last_error })
    }
  }
  return out
}

/**
 * Rides the follow-ups cron, before the notification sweep:
 * 1. Form requests unanswered for 72 h become 'expired' (visible, not silently
 *    dropped) and owners/admins get one notice to follow up by hand. No
 *    automatic customer message: opt-out, hours and WhatsApp limits stay a
 *    person's call.
 * 2. Requests stuck mid-placement and notices that do not go out raise one
 *    platform alert per account; it resolves itself once clear.
 */
export async function runShopifyBacklogCheck(db: SupabaseClient, now: Date = new Date()): Promise<{ expired: number; stuckAccounts: number }> {
  const res = { expired: 0, stuckAccounts: 0 }

  const { data: expired, error: expireError } = await db.from('shopify_order_requests')
    .update({ status: 'expired', decided_at: now.toISOString() })
    .eq('status', 'pending').lt('created_at', new Date(now.getTime() - REQUEST_TTL_MS).toISOString())
    .select('id, account_id, conversation_id, proposal, total, currency')
  if (expireError) throw new Error(`Cannot expire order requests: ${expireError.message}`)
  for (const r of expired ?? []) {
    const { data: recipients, error } = await db.from('profiles').select('user_id')
      .eq('account_id', r.account_id).in('account_role', ['owner', 'admin'])
    if (error) throw error
    if (recipients?.length) {
      const proposal = r.proposal as { fullName?: string; items: { name: string; qty: number }[] }
      await enqueueOrderNotification(db, r.account_id as string, `request:${r.id}:expired`, {
        conversationId: r.conversation_id as string, text: '', template: null,
        staff: {
          userIds: recipients.map((p) => p.user_id as string),
          title: 'Solicitud de pedido sin respuesta',
          body: `📝 ${proposal.fullName || 'Un cliente'} pidió ${requestSummary(proposal)} (${formatCurrency(Number(r.total), r.currency as string)}) ` +
            'por el formulario y no respondió en 72 h. No se creó pedido. Si quiere recuperarla, escríbale desde este chat.',
        },
      })
    }
    res.expired++
  }

  const [{ data: accounts, error: cfgError }, { data: requests, error: reqError }, { data: jobs, error: jobError }] = await Promise.all([
    db.from('shopify_config').select('account_id'),
    db.from('shopify_order_requests').select('id, account_id, decided_at').eq('status', 'processing'),
    db.from('shopify_notification_jobs').select('account_id, event_key, attempts, created_at, last_error').in('status', ['pending', 'processing']),
  ])
  if (cfgError || reqError || jobError) throw new Error(`Cannot read Shopify backlog: ${(cfgError ?? reqError ?? jobError)!.message}`)
  const stuck = stuckByAccount((requests ?? []) as RequestRow[], (jobs ?? []) as JobRow[], now)
  for (const { account_id: accountId } of accounts ?? []) {
    const dedupKey = `shopify_backlog:${accountId}`
    const s = stuck.get(accountId as string)
    if (!s) { await resolveSystemAlert(dedupKey); continue }
    res.stuckAccounts++
    await dispatchSystemAlert({
      severity: 'warning', source: 'shopify_backlog', dedupKey, accountId: accountId as string, throttleMinutes: 6 * 60,
      title: `Pedidos Shopify atascados: ${s.requests.length} solicitud(es) sin resultado, ${s.jobs.length} aviso(s) sin entregar`,
      detail: { requests: s.requests.slice(0, 10), jobs: s.jobs.slice(0, 10) },
    })
  }
  return res
}
