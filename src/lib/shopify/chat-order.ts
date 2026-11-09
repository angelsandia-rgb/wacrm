import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerateResult } from '@/lib/ai/types'
import { formatCurrency } from '@/lib/currency'
import {
  attachOrderToDeal, createRecurrenteCheckout, createShopifyOrder, departamentoCode, loadShopifyConfig, normalizeGtPhone,
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
}): Promise<void> {
  const { db, accountId, contactId, conversationId, configOwnerUserId, proposal, handoff, sendText } = args
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
    return
  }

  const fail = (reason: string) =>
    handoff(`🤖 La IA confirmó un pedido (${label}) pero no se pudo crear en Shopify: ${reason}. Créalo manualmente.`)

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
    input: { conversation_id: conversationId, ...proposal, source: 'auto_reply_autonomous' },
    result: { order_id: order.id, name: order.name, draft: order.draft, total: order.total },
  })
  if (logError) console.error('[shopify] create_shopify_order log failed:', logError.message)

  await attachOrderToDeal({ db, accountId, userId: configOwnerUserId, contactId, order, currency })

  const totalText = formatCurrency(order.total, currency)
  let payLine = `Pagas ${totalText} al recibir.`
  let paymentLink: string | null = null
  if (proposal.payment === 'card') {
    if (cfg.recurrenteSecretKey) {
      try {
        paymentLink = await createRecurrenteCheckout(cfg.recurrenteSecretKey, {
          title: `Pedido ${order.name}`, total: order.total, currency, orderId: order.id,
        })
      } catch (err) {
        console.error('[shopify] recurrente checkout failed:', err instanceof Error ? err.message : err)
      }
    }
    payLine = paymentLink
      ? `Paga ${totalText} con tarjeta aquí: ${paymentLink} — en cuanto se confirme el pago preparamos tu envío.`
      : `Un asesor te enviará por aquí el link de pago con tarjeta por ${totalText}.`
  }
  try {
    await sendText(
      `✅ Pedido ${order.name} registrado: ${label}. Envío a ${proposal.address}, ${proposal.departamento}. ${payLine}`,
    )
  } catch (err) {
    console.error('[shopify] order confirmation send failed:', err)
  }

  // With real orders on and the Recurrente webhook set, a paid card draft is
  // completed automatically (/api/shopify/recurrente-webhook) — no handoff,
  // the AI keeps the chat.
  const autoCompletes = proposal.payment === 'card' && paymentLink && cfg.ordersLive && cfg.recurrenteWebhookSecret
  if (order.draft && !autoCompletes) {
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
}
