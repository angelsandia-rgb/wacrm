import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyCustomer } from './notify'
import { CANCEL_REQUESTED_TAG, CONFIRMED_TAG, loadShopifyConfig, shopifyGraphql } from './api'
import { contactMutesAi } from '@/lib/ai/muted-contact'
import { withinBusinessHours } from '@/lib/ai/followups'

export interface OrderNotification {
  conversationId: string
  text: string
  template: { names: readonly string[]; params: string[] } | null
  /** Revalidate delayed confirmation jobs before every retry. */
  confirmation?: { orderId: string; contactId: string; since: string; reminder: boolean }
  staff?: { userIds: string[]; title: string; body: string; ids?: string[] }
}

export async function enqueueOrderNotification(db: SupabaseClient, accountId: string, eventKey: string, payload: OrderNotification) {
  const stored = payload.staff
    ? { ...payload, staff: { ...payload.staff, ids: payload.staff.userIds.map(() => randomUUID()) } }
    : payload
  const { error } = await db.from('shopify_notification_jobs').upsert({
    account_id: accountId, event_key: eventKey, payload: stored,
  }, { onConflict: 'account_id,event_key', ignoreDuplicates: true })
  if (error) throw new Error(`Cannot queue order notification: ${error.message}`)
}

export async function runOrderNotificationSweep(db: SupabaseClient, accountId?: string, eventKey?: string) {
  const { data, error } = await db.rpc('claim_shopify_notification_jobs', {
    p_account_id: accountId ?? null, p_event_key: eventKey ?? null,
  })
  if (error) throw new Error(`Cannot claim order notifications: ${error.message}`)
  const result = { sent: 0, pending: 0, skipped: 0 }
  for (const job of data ?? []) {
    let status: 'sent' | 'pending' | 'skipped' = 'pending'
    let lastError: string | null = null
    try {
      const payload = job.payload as OrderNotification
      let skip = false
      if (payload.confirmation) {
        const c = payload.confirmation
        const { data: deal, error: dealError } = await db.from('deals').select('shopify_confirmation_decision')
          .eq('account_id', job.account_id).eq('shopify_order_id', c.orderId).maybeSingle()
        if (dealError) throw dealError
        const cfg = await loadShopifyConfig(db, job.account_id)
        if (!cfg) throw new Error('Shopify configuration unavailable')
        const { order } = await shopifyGraphql<{ order: { tags: string[]; cancelledAt: string | null; displayFulfillmentStatus?: string } | null }>(
          cfg, 'query($id: ID!) { order(id: $id) { tags cancelledAt displayFulfillmentStatus } }', { id: c.orderId },
        )
        skip = Boolean(deal?.shopify_confirmation_decision) || !order || Boolean(order.cancelledAt) || order.tags.some((t) => [CANCEL_REQUESTED_TAG, CONFIRMED_TAG].includes(t))
        skip ||= ['FULFILLED', 'PARTIALLY_FULFILLED'].includes(order?.displayFulfillmentStatus ?? '')
        if (!payload.staff) skip ||= await contactMutesAi(db, c.contactId)
        if (c.reminder) {
          const { data: inbound, error: inboundError } = await db.from('messages').select('id')
            .eq('conversation_id', payload.conversationId).eq('sender_type', 'customer').gt('created_at', c.since).limit(1)
          if (inboundError) throw inboundError
          skip ||= Boolean(inbound?.length) || Date.now() - Date.parse(c.since) >= 24 * 3600_000
        }
        if (!skip && (c.reminder || payload.staff)) {
          const { data: account, error: accountError } = await db.from('accounts').select('timezone').eq('id', job.account_id).maybeSingle()
          if (accountError) throw accountError
          if (!withinBusinessHours(new Date(), account?.timezone || 'America/Guatemala', 8, 20)) {
            throw new Error('Waiting for business hours')
          }
        }
      }
      if (skip) status = 'skipped'
      else if (payload.staff) {
        const { error: insertError } = await db.from('notifications').upsert(payload.staff.userIds.map((userId, i) => ({
          id: payload.staff!.ids![i], account_id: job.account_id, user_id: userId,
          type: 'ai_handoff', conversation_id: payload.conversationId,
          title: payload.staff!.title, body: payload.staff!.body,
        })), { onConflict: 'id', ignoreDuplicates: true })
        if (insertError) throw insertError
        status = 'sent'
      } else {
        status = await notifyCustomer(db, job.account_id, payload.conversationId, payload.text, payload.template) ? 'sent' : 'pending'
        if (status === 'pending') lastError = 'No approved template outside messaging window'
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    // Compare the lease: a stale worker must never overwrite a newer attempt.
    const { error: saveError } = await db.from('shopify_notification_jobs').update({
      status, last_error: lastError, lease_token: null,
      next_attempt_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    }).eq('account_id', job.account_id).eq('event_key', job.event_key).eq('lease_token', job.lease_token)
    if (saveError) throw new Error(`Cannot save notification result: ${saveError.message}`)
    result[status]++
  }
  return result
}
