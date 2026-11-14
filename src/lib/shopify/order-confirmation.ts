import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CONFIRM_STAGE_NAME,
} from './api'
import { runOrderNotificationSweep } from './notification-jobs'

const sameName = (a: unknown, b: string) => String(a ?? '').trim().toLowerCase() === b.toLowerCase()

export interface PendingOrder { dealId: string; orderId: string; orderName: string; pipelineId: string }

/** The contact's web cash-on-delivery order still waiting for their
 *  WhatsApp confirmation: an open deal with a Shopify order sitting in the
 *  "Por confirmar" stage. Null when there is none (or no such stage). */
export async function loadPendingOrderConfirmation(
  db: SupabaseClient, accountId: string, contactId: string,
): Promise<PendingOrder | null> {
  const { data: deals } = await db
    .from('deals').select('id, title, shopify_order_id, stage_id, pipeline_id')
    .eq('account_id', accountId).eq('contact_id', contactId).eq('status', 'open')
    .is('shopify_confirmation_decision', null)
    .not('shopify_order_id', 'is', null)
    .order('updated_at', { ascending: false }).limit(3)
  const withStage = (deals ?? []).filter((d) => d.stage_id && String(d.shopify_order_id).startsWith('gid://shopify/Order/'))
  if (!withStage.length) return null
  const { data: stages } = await db.from('pipeline_stages').select('id, name').in('id', withStage.map((d) => d.stage_id as string))
  const pendingStageIds = new Set((stages ?? []).filter((s) => sameName(s.name, CONFIRM_STAGE_NAME)).map((s) => s.id as string))
  const deal = withStage.find((d) => pendingStageIds.has(d.stage_id as string))
  if (!deal) return null
  return {
    dealId: deal.id as string,
    orderId: deal.shopify_order_id as string,
    orderName: String(deal.title ?? '').match(/#\d+/)?.[0] ?? 'su pedido',
    pipelineId: deal.pipeline_id as string,
  }
}

/** The customer answered the confirmation request. Confirmed: the deal
 *  moves to "Pedido creado", the order is tagged confirmado-whatsapp and
 *  the team is notified. Cancelled: tagged cliente-cancela; the transaction
 *  hands the chat to a person, who cancels it in Dropi and Shopify (never
 *  cancelled automatically — that can't be undone). Returns the staff line. */
export async function resolveOrderConfirmation(args: {
  db: SupabaseClient; accountId: string; conversationId: string; pending: PendingOrder; decision: 'confirm' | 'cancel'; handoffAgentId?: string | null
}): Promise<string> {
  const { db, accountId, conversationId, pending, decision } = args
  // Decision, stage/handoff, internal note, staff alerts and the remote tag
  // job commit together. A retry never accepts an answer with missing effects.
  const { data, error } = await db.rpc('record_shopify_order_decision', {
    p_account_id: accountId, p_deal_id: pending.dealId, p_order_id: pending.orderId,
    p_conversation_id: conversationId, p_decision: decision,
    p_handoff_agent_id: args.handoffAgentId ?? null,
  })
  if (error) throw new Error(`Cannot save order confirmation: ${error.message}`)
  await runOrderNotificationSweep(db, accountId, `${pending.orderId}:decision`)
  return data as string
}
