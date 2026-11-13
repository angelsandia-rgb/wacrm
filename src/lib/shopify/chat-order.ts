import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerateResult } from '@/lib/ai/types'
import { formatCurrency } from '@/lib/currency'
import {
  attachOrderToDeal, createRecurrenteCheckout, createShopifyOrder, departamentoCode, loadShopifyConfig, normalizeGtPhone, outOfStockTitles,
  PAYMENT_GATEWAYS, ShopifyError,
} from './api'

// A re-emitted marker (the customer says "gracias" after confirming)
// must never place a second order.
const DUPLICATE_WINDOW_MS = 30 * 60_000

/**
 * The `create_shopify_order` marker → a Shopify order (or draft order,
 * see `orders_live`). Item names are re-resolved against the account's
 * real, active, Shopify-synced products — never trusted as-is — and any
 * gap (unknown product, bad phone/departamento, Shopify error) hands the
 * chat to a human instead of going quiet, same discipline as quotes.
 */
export async function createShopifyOrderFromChat(args: {
  db: SupabaseClient
  accountId: string
  contactId: string
  conversationId: string
  configOwnerUserId: string
  proposal: NonNullable<GenerateResult['shopifyOrderProposal']>
  handoff: (reason: string) => Promise<void>
  sendText: (text: string) => Promise<void>
  /** 'agent': a teammate placed it from the inbox (POST /api/shopify/orders) —
   *  `handoff` receives the bare reason for the UI and no follow-up handoff is
   *  raised, the agent is already on the chat. Defaults to the AI. */
  actor?: 'ai' | 'agent'
}): Promise<{ id: string; name: string; draft: boolean; paymentLink: string | null } | void> {
  const { db, accountId, contactId, conversationId, configOwnerUserId, proposal, handoff, sendText } = args
  const byAgent = args.actor === 'agent'
  const label = proposal.items.map((i) => `${i.name} x${i.qty}`).join(', ')

  let cfg
  try {
    cfg = await loadShopifyConfig(db, accountId)
  } catch (err) {
    // Client-credentials token refresh failed — a human must take the order.
    return handoff(`Pedido Shopify no creado (${label}): ${err instanceof Error ? err.message : 'sin acceso a Shopify'}`)
  }
  if (!cfg) return

  const { data: recent } = await db
    .from('ai_action_log')
    .select('id')
    .eq('account_id', accountId)
    .eq('action', 'create_shopify_order')
    .contains('input', { conversation_id: conversationId })
    .gte('created_at', new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString())
    .limit(1)
  if (recent?.length) {
    console.warn('[shopify] create_shopify_order: order already created for this chat in the last 30 min, skipping')
    if (byAgent) await handoff('Ya se creó un pedido para este chat hace menos de 30 minutos')
    return
  }

  const fail = (reason: string) => byAgent
    ? handoff(reason)
    : handoff(`🤖 La IA confirmó un pedido (${label}) pero no se pudo crear en Shopify: ${reason}. Créalo manualmente.`)

  if (normalizeGtPhone(proposal.phone).replace(/\D/g, '').length < 11) return fail(`teléfono inválido "${proposal.phone}"`)
  if (!departamentoCode(proposal.departamento)) return fail(`departamento desconocido "${proposal.departamento}"`)

  const { data: products } = await db
    .from('products')
    .select('name, price, shopify_variant_id')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .not('shopify_variant_id', 'is', null)
  const byName = new Map((products ?? []).map((p) => [String(p.name).trim().toLowerCase(), p]))
  const lines = []
  for (const item of proposal.items) {
    const p = byName.get(item.name.trim().toLowerCase())
    if (!p) return fail(`"${item.name}" no coincide con un producto activo de Shopify`)
    lines.push({ variantId: p.shopify_variant_id as string, quantity: item.qty, price: Number(p.price), title: p.name as string })
  }

  // Provider stock first: no order, no payment link for what Dropi can't ship.
  // A provider outage must not produce an unchecked order or payment link.
  let missing: string[] = []
  try {
    missing = await outOfStockTitles(cfg, lines)
  } catch (err) {
    console.error('[shopify] stock check failed:', err instanceof Error ? err.message : err)
    return fail('No se pudieron verificar las existencias. Reintente antes de crear el pedido o cobrar.')
  }
  if (missing.length) {
    const what = missing.join(', ')
    if (!byAgent) {
      try {
        await sendText(`Le ofrezco una disculpa 🙏 En este momento no tenemos existencias de ${what}. Un asesor le escribe por aquí para ofrecerle una alternativa o avisarle cuándo vuelve a estar disponible.`)
      } catch (err) {
        console.error('[shopify] out-of-stock notice failed:', err)
      }
    }
    return handoff(byAgent ? `Sin existencias en Dropi: ${what}` : `🛒 Sin existencias en Dropi para el pedido (${label}): ${what}. Ofrécele una alternativa al cliente.`)
  }

  const { data: account } = await db.from('accounts').select('default_currency').eq('id', accountId).maybeSingle()
  const currency = (account?.default_currency as string | undefined) ?? 'GTQ'

  let order
  try {
    order = await createShopifyOrder(cfg, {
      lines, currency,
      fullName: proposal.fullName, phone: proposal.phone, address: proposal.address,
      departamento: proposal.departamento, payment: proposal.payment,
      note: 'Pedido tomado por WhatsApp (Chat Sandía)',
    })
  } catch (err) {
    if (err instanceof ShopifyError) return fail(err.message)
    throw err
  }

  // Logged first: the order exists now, so the duplicate guard above must see it
  // even if the deal or the confirmation message below fails.
  // target_id is a uuid column: a Shopify gid there made every insert fail
  // silently, so the duplicate guard never saw an order (Casa Ceiba 2026-11-08).
  const { error: logError } = await db.from('ai_action_log').insert({
    account_id: accountId,
    actor_user_id: configOwnerUserId,
    action: 'create_shopify_order',
    target_id: conversationId,
    input: { conversation_id: conversationId, ...proposal, source: byAgent ? 'agent_manual' : 'auto_reply_autonomous' },
    result: { order_id: order.id, name: order.name, draft: order.draft, total: order.total },
  })
  if (logError) console.error('[shopify] create_shopify_order log failed:', logError.message)

  await attachOrderToDeal({ db, accountId, userId: configOwnerUserId, contactId, order, currency })

  const totalText = formatCurrency(order.total, currency)
  let payLine = order.draft
    ? `Pago contra entrega: ${totalText}.`
    : `Pago contra entrega: ${totalText}. Número de pedido: *${order.name}* (para darle seguimiento).`
  let paymentLink: string | null = null
  if (proposal.payment === 'card') {
    if (cfg.recurrenteSecretKey) {
      try {
        paymentLink = await createRecurrenteCheckout(cfg.recurrenteSecretKey, {
          // The customer sees this on Recurrente's page — the items, not a draft "#D3".
          title: label.slice(0, 120), total: order.total, currency, orderId: order.id,
        })
      } catch (err) {
        console.error('[shopify] recurrente checkout failed:', err instanceof Error ? err.message : err)
      }
    }
    payLine = paymentLink
      ? `Pago con tarjeta (${totalText}) en este link seguro: ${paymentLink} — al confirmarse el pago llega por aquí el número de pedido y se prepara el envío.`
      : `En breve llega por aquí el link de pago con tarjeta por ${totalText}.`
  }
  try {
    // A draft's "#D3" isn't the order number the customer tracks; the real
    // one comes with the payment confirmation (recurrente-webhook).
    const heading = order.draft ? '✅ Pedido registrado' : `✅ Pedido ${order.name} confirmado`
    const where = proposal.address.toLowerCase().includes(proposal.departamento.toLowerCase())
      ? proposal.address : `${proposal.address}, ${proposal.departamento}`
    await sendText(`${heading}: ${label}. Envío a ${where}. ${payLine} Para saber cómo va el pedido, basta con escribir por aquí.`)
  } catch (err) {
    console.error('[shopify] order confirmation send failed:', err)
  }

  // With real orders on and the Recurrente webhook set, a paid card draft is
  // completed automatically (/api/shopify/recurrente-webhook) — no handoff,
  // the AI keeps the chat.
  const autoCompletes = proposal.payment === 'card' && paymentLink && cfg.ordersLive && cfg.recurrenteWebhookSecret
  if (order.draft && !autoCompletes && !byAgent) {
    // A human has to finish it in Shopify: a card order once Recurrente shows
    // it paid (mark it paid there, so Dropi never collects cash), or any order
    // while "Crear pedidos reales" is off.
    const todo = proposal.payment === 'card'
      ? (paymentLink
          ? 'se envió el link de Recurrente; cuando el pago aparezca, completa el borrador como PAGADO para que llegue a Dropi.'
          : 'envía el link de pago con tarjeta y, cuando se pague, completa el borrador como PAGADO.')
      : 'complétalo para que llegue a Dropi.'
    await handoff(`🛒 Borrador ${order.name} en Shopify (${label}, ${totalText}, ${PAYMENT_GATEWAYS[proposal.payment]}): ${todo}`)
  }
  return { id: order.id, name: order.name, draft: order.draft, paymentLink }
}
