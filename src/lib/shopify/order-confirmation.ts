import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CANCEL_REQUESTED_TAG, CONFIRM_STAGE_NAME, CONFIRMED_TAG, loadShopifyConfig, ORDER_PLACED_STAGE_NAME, TO_CONFIRM_TAG,
  updateOrderTags,
} from './api'

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
 *  the team is notified. Cancelled: tagged cliente-cancela; the caller
 *  hands the chat to a person, who cancels it in Dropi and Shopify (never
 *  cancelled automatically — that can't be undone). Returns the staff line. */
export async function resolveOrderConfirmation(args: {
  db: SupabaseClient; accountId: string; conversationId: string; pending: PendingOrder; decision: 'confirm' | 'cancel'
}): Promise<string> {
  const { db, accountId, conversationId, pending, decision } = args
  const confirmed = decision === 'confirm'
  if (confirmed) {
    const { data: stages } = await db.from('pipeline_stages').select('id, name').eq('pipeline_id', pending.pipelineId)
    const placed = (stages ?? []).find((s) => sameName(s.name, ORDER_PLACED_STAGE_NAME))
    if (placed) await db.from('deals').update({ stage_id: placed.id }).eq('id', pending.dealId).eq('account_id', accountId)
  }
  try {
    const cfg = await loadShopifyConfig(db, accountId)
    if (cfg) await updateOrderTags(cfg, pending.orderId, [confirmed ? CONFIRMED_TAG : CANCEL_REQUESTED_TAG], [TO_CONFIRM_TAG])
  } catch (err) {
    console.error(`[shopify] order ${pending.orderName} confirmation tags failed:`, err instanceof Error ? err.message : err)
  }
  const line = confirmed
    ? `✅ El cliente confirmó por WhatsApp el pedido ${pending.orderName} (contra entrega). Ya puede despacharse en Dropi.`
    : `❌ El cliente NO confirma el pedido ${pending.orderName}: cancélelo en Dropi y en Shopify antes de que se despache.`
  if (confirmed) {
    const { data: recipients } = await db
      .from('profiles').select('user_id').eq('account_id', accountId).in('account_role', ['owner', 'admin'])
    if (recipients?.length) {
      await db.from('notifications').insert(recipients.map((r) => ({
        account_id: accountId, user_id: r.user_id as string, type: 'ai_handoff', conversation_id: conversationId,
        title: `Pedido ${pending.orderName} confirmado`, body: line,
      })))
    }
  }
  return line
}
