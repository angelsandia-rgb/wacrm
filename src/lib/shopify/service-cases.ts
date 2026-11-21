import type { SupabaseClient } from '@supabase/supabase-js'
import { loadOrderStatuses, type OrderStatus } from './api'

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

/** Pure: a damaged / defective / wrong product claim (a Dropi warranty). */
export function isWarrantyClaim(text: string): boolean {
  return /da[ñn]ad|defect|\brot[oa]s?\b|romp|quebrad|no (?:enciende|prende|funciona|sirve|carga|calienta|enfr[ií]a)|equivocad|incomplet|falla/i.test(text)
}

/** Pure: the order the claim is about — the #number the customer gave, else the latest. */
export function claimedOrder(orders: OrderStatus[], text: string): OrderStatus | null {
  const n = text.match(/#\s?(\d{3,})/)?.[1]
  return (n && orders.find((o) => o.name === `#${n}`)) || orders[0] || null
}

/** Pure: the text the owner pastes in Dropi → Garantías. Facts only, from Shopify. */
export function warrantyBrief(order: OrderStatus | null, summary: string): string {
  const quote = summary.match(/“([^”]+)”/g)?.map((q) => q.slice(1, -1)).join(' / ') || 'ver el chat'
  const tracking = order?.fulfillments.flatMap((f) => f.trackingInfo.map((t) => [t.company, t.number].filter(Boolean).join(' '))).filter(Boolean) ?? []
  const delivery = order?.fulfillments.map((f) => f.displayStatus).filter(Boolean).join(', ')
  return [
    'GARANTÍA DROPI — texto para pegar',
    order ? `Pedido Shopify: ${order.name} (creado ${order.createdAt.slice(0, 10)})` : 'Pedido: no identificado — pídale el número al cliente.',
    order ? `Envío: ${delivery || order.displayFulfillmentStatus}${tracking.length ? ` · guía ${tracking.join(' / ')}` : ''}` : null,
    `Problema que reporta el cliente: ${quote}`,
    'Evidencia: fotos o video del producto y del empaque en el chat del cliente (descárguelos de ahí).',
    `Pasos: Dropi → Garantías → busque el pedido${order ? ` ${order.name}` : ''} → pegue este texto y suba las fotos. Sin respuesta del proveedor en 72 h: escale a soporte de Dropi.`,
  ].filter(Boolean).join('\n')
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
    // A damaged-product claim becomes a warranty case: the order read from
    // Shopify (only the customer's own, by phone) and the text for Dropi.
    let title = serviceCaseTitle(summary)
    let notes = summary
    if (isWarrantyClaim(summary)) {
      const { data: contact } = await db.from('contacts').select('phone').eq('id', conv.contact_id).eq('account_id', accountId).maybeSingle()
      const orders = await loadOrderStatuses({
        db, accountId, contactId: conv.contact_id as string, contactPhone: (contact?.phone as string | null) ?? '', text: summary,
      }).catch(() => [])
      const order = claimedOrder(orders, summary)
      title = SERVICE_CASE_PREFIX + `Garantía${order ? ` ${order.name}` : ''} — ` + title.slice(SERVICE_CASE_PREFIX.length)
      notes = `${summary}\n\n${warrantyBrief(order, summary)}`
    }
    const { error } = await db.from('tasks').insert({
      account_id: accountId, created_by: owner, assigned_to: owner, contact_id: conv.contact_id,
      title: title.length > 160 ? `${title.slice(0, 159)}…` : title, notes: notes.slice(0, 4000),
      due_at: new Date(now.getTime() + SERVICE_CASE_DUE_MS).toISOString(),
    })
    if (error) console.error('[service case] insert failed:', error.message)
  } catch (err) {
    console.error('[service case] failed:', err instanceof Error ? err.message : err)
  }
}
