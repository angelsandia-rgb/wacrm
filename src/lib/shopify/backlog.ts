import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/currency'
import { dispatchSystemAlert, resolveSystemAlert } from '@/lib/observability/alerts'
import { enqueueOrderNotification } from './notification-jobs'
import { REQUEST_TTL_MS, requestSummary } from './order-requests'
import { SERVICE_CASE_ESCALATE_MS, SERVICE_CASE_PREFIX } from './service-cases'

/** One reminder, this long after the summary reached WhatsApp with no answer. */
export const REQUEST_REMINDER_MS = 3 * 3600_000
/** {{1}} name, {{2}} order. Its promise ("no lo enviaremos hasta que lo confirme")
 *  is true for a form request: no order exists until the customer accepts. */
const REQUEST_REMINDER_TEMPLATE = ['recordatorio_confirmacion']

/** Pure: the reminder for a purchase whose summary got no answer. */
export function requestReminderText(firstName: string, summary: string, total: string): string {
  return `Hola${firstName ? ` ${firstName}` : ''}, su pedido de ${summary} por ${total} sigue esperando su confirmación; no lo enviamos hasta que nos confirme. ` +
    'Responda *SÍ* y lo preparamos, o díganos qué desea cambiar.'
}

/** A "sí" being placed takes seconds; this long means the worker died mid-way. */
const STUCK_PROCESSING_MS = 15 * 60_000
/** A notice still undelivered after this long (or this many tries) needs a person. */
const STUCK_JOB_MS = 2 * 3600_000
const STUCK_JOB_ATTEMPTS = 8

interface JobRow { account_id: string; event_key: string; attempts: number; created_at: string; last_error: string | null }
interface RequestRow { id: string; account_id: string; decided_at: string | null }
interface CaseRow { id: string; account_id: string; created_at: string }
type Stuck = { requests: string[]; jobs: { key: string; error: string | null }[]; cases: string[] }

/** Pure: per account, what is stuck. Deliberate waits (business hours, cart
 *  inactivity) are not stuck — they say so in last_error. */
export function stuckByAccount(requests: RequestRow[], jobs: JobRow[], now: Date, cases: CaseRow[] = []): Map<string, Stuck> {
  const out = new Map<string, Stuck>()
  const entry = (id: string) => out.get(id) ?? out.set(id, { requests: [], jobs: [], cases: [] }).get(id)!
  // SAC escalation: a case nobody closed in 24 h.
  for (const c of cases) {
    if (now.getTime() - Date.parse(c.created_at) >= SERVICE_CASE_ESCALATE_MS) entry(c.account_id).cases.push(c.id)
  }
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
 * 0. A form request whose summary was delivered 3 h ago with no answer gets
 *    ONE reminder (the sender applies opt-out, business hours and "the
 *    customer already wrote back").
 * 1. Form requests unanswered for 72 h become 'expired' (visible, not silently
 *    dropped) and owners/admins get one notice to follow up by hand.
 * 2. Requests stuck mid-placement, notices that do not go out and SAC cases
 *    open > 24 h raise one platform alert per account; it resolves itself once clear.
 */
export async function runShopifyBacklogCheck(db: SupabaseClient, now: Date = new Date()): Promise<{ expired: number; stuckAccounts: number }> {
  const res = { expired: 0, stuckAccounts: 0 }

  // ponytail: re-queues every waiting request each run (the job key makes it one reminder); keep a reminded_at column if this ever scans thousands.
  const { data: waiting, error: waitingError } = await db.from('shopify_order_requests')
    .select('id, account_id, conversation_id, contact_id, proposal, total, currency, ask_delivered_at')
    .eq('status', 'pending').lt('ask_delivered_at', new Date(now.getTime() - REQUEST_REMINDER_MS).toISOString())
    .gt('created_at', new Date(now.getTime() - REQUEST_TTL_MS).toISOString())
  if (waitingError) throw new Error(`Cannot read waiting order requests: ${waitingError.message}`)
  for (const r of waiting ?? []) {
    const proposal = r.proposal as { fullName?: string; items: { name: string; qty: number }[] }
    const firstName = (proposal.fullName ?? '').trim().split(' ')[0]
    const summary = requestSummary(proposal)
    await enqueueOrderNotification(db, r.account_id as string, `request:${r.id}:reminder`, {
      conversationId: r.conversation_id as string,
      text: requestReminderText(firstName, summary, formatCurrency(Number(r.total), r.currency as string)),
      template: { names: REQUEST_REMINDER_TEMPLATE, params: [firstName || 'cliente', `de ${summary}`] },
      request: { id: r.id as string, reminder: { contactId: r.contact_id as string, since: r.ask_delivered_at as string } },
    })
  }

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

  const [{ data: accounts, error: cfgError }, { data: requests, error: reqError }, { data: jobs, error: jobError }, { data: cases, error: caseError }] = await Promise.all([
    db.from('shopify_config').select('account_id'),
    db.from('shopify_order_requests').select('id, account_id, decided_at').eq('status', 'processing'),
    db.from('shopify_notification_jobs').select('account_id, event_key, attempts, created_at, last_error').in('status', ['pending', 'processing']),
    db.from('tasks').select('id, account_id, created_at').eq('status', 'open').like('title', `${SERVICE_CASE_PREFIX}%`),
  ])
  const readError = cfgError ?? reqError ?? jobError ?? caseError
  if (readError) throw new Error(`Cannot read Shopify backlog: ${readError.message}`)
  const stuck = stuckByAccount((requests ?? []) as RequestRow[], (jobs ?? []) as JobRow[], now, (cases ?? []) as CaseRow[])
  for (const { account_id: accountId } of accounts ?? []) {
    const dedupKey = `shopify_backlog:${accountId}`
    const s = stuck.get(accountId as string)
    if (!s) { await resolveSystemAlert(dedupKey); continue }
    res.stuckAccounts++
    await dispatchSystemAlert({
      severity: 'warning', source: 'shopify_backlog', dedupKey, accountId: accountId as string, throttleMinutes: 6 * 60,
      title: `Tienda con pendientes atascados: ${s.requests.length} solicitud(es) sin resultado, ${s.jobs.length} aviso(s) sin entregar, ${s.cases.length} caso(s) SAC abiertos > 24 h`,
      detail: { requests: s.requests.slice(0, 10), jobs: s.jobs.slice(0, 10), cases: s.cases.slice(0, 10) },
    })
  }
  return res
}
