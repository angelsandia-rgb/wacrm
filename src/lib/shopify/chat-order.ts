import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerateResult } from '@/lib/ai/types'
import { formatCurrency } from '@/lib/currency'
import {
  attachOrderToDeal, createShopifyOrder, departamentoCode, loadShopifyConfig, normalizeGtPhone,
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

  const cfg = await loadShopifyConfig(db, accountId)
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
  await db.from('ai_action_log').insert({
    account_id: accountId,
    actor_user_id: configOwnerUserId,
    action: 'create_shopify_order',
    target_id: order.id,
    input: { conversation_id: conversationId, ...proposal, source: 'auto_reply_autonomous' },
    result: { order_id: order.id, name: order.name, draft: order.draft, total: order.total },
  })

  await attachOrderToDeal({ db, accountId, userId: configOwnerUserId, contactId, order, currency })

  const payLine = proposal.payment === 'cod'
    ? `Pagas ${formatCurrency(order.total, currency)} al recibir.`
    : `Te enviaremos por aquí el link de pago con tarjeta por ${formatCurrency(order.total, currency)}.`
  try {
    await sendText(
      `✅ Pedido ${order.name} registrado: ${label}. Envío a ${proposal.address}, ${proposal.departamento}. ${payLine}`,
    )
  } catch (err) {
    console.error('[shopify] order confirmation send failed:', err)
  }

  if (order.draft || proposal.payment === 'card') {
    // Draft = a human must complete it in Shopify; card = a human must send the
    // Recurrente link. Either way the team needs to see this chat now.
    await handoff(
      `🛒 Pedido ${order.name} (${label}, ${formatCurrency(order.total, currency)}, ${PAYMENT_GATEWAYS[proposal.payment]})` +
        (order.draft ? ' creado como BORRADOR en Shopify: complétalo para que llegue a Dropi.' : ': envía el link de pago con tarjeta.'),
    )
  }
}
