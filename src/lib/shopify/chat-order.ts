import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerateResult } from '@/lib/ai/types'
import { formatCurrency } from '@/lib/currency'
import {
  attachOrderToDeal, catalogVariantsById, coverageVerdict, createRecurrenteCheckout, createShopifyOrder, departamentoCode, loadShopifyConfig,
  normalizeGtPhone, outOfStockTitles,
  PAYMENT_GATEWAYS, resolveCatalogVariant, type VariantOption,
} from './api'

type CatalogRow = { name: string; price: number | string; shopify_variant_id: string; variant_options: VariantOption[] | null }
import { recordCardCheckout } from './card-payments'
import { checkMunicipio } from './gt-geo'
import type { AcceptedTerms } from './order-requests'

/**
 * The `create_shopify_order` marker → a Shopify order (or draft order,
 * see `orders_live`). Item names are re-resolved against the account's
 * real, active, Shopify-synced products — never trusted as-is — and any
 * gap (unknown product, bad phone/departamento, Shopify error) hands the
 * chat to a human instead of going quiet, same discipline as quotes.
 */
async function createShopifyOrderLocked(args: {
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
  /** A web form request: the exact variants, quantities, prices and currency
   *  the customer accepted. Any difference from the current catalog → no
   *  order, no link; a person re-quotes. */
  accepted?: AcceptedTerms
  /** The form request being placed: its id is the purchase's lock key. */
  requestId?: string
}, lifecycle: {
  starting: () => void
  created: (order: { id: string; name: string; draft: boolean }) => Promise<void>
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

  // A duplicate of the same purchase is stopped by the per-purchase claim in
  // createShopifyOrderFromChat; a different purchase in this chat goes ahead.

  const fail = (reason: string) => byAgent
    ? handoff(reason)
    : handoff(`🤖 La IA confirmó un pedido (${label}) pero no se pudo crear en Shopify: ${reason}. Créalo manualmente.`)

  if (normalizeGtPhone(proposal.phone).replace(/\D/g, '').length < 11) return fail(`teléfono inválido "${proposal.phone}"`)
  if (!departamentoCode(proposal.departamento)) return fail(`departamento desconocido "${proposal.departamento}"`)
  if (proposal.municipio) {
    const place = checkMunicipio(proposal.municipio, proposal.departamento)
    if (!place.ok) {
      return fail(place.departamentos.length
        ? `el municipio "${proposal.municipio}" pertenece a ${place.departamentos.join(' o ')}, no a "${proposal.departamento}"; confirme la ubicación con el cliente`
        : `"${proposal.municipio}" no es un municipio de "${proposal.departamento}" (puede ser una aldea o zona); confirme el municipio con el cliente`)
    }
  }
  // Checked again here, not only when the request was made: a coverage change
  // after the customer's form also stops the order and the payment link.
  const coverage = coverageVerdict(cfg.shippingCoverage, proposal.departamento, proposal.municipio)
  if (coverage !== 'ok') {
    const where = [proposal.municipio, proposal.departamento].filter(Boolean).join(', ')
    return fail(coverage === 'outside'
      ? `${where} está fuera de la cobertura de envío configurada; no se creó pedido ni link de pago`
      : `falta el municipio para confirmar la cobertura de envío (${where}); no se creó pedido ni link de pago`)
  }

  const { data: products } = await db
    .from('products')
    .select('name, price, shopify_variant_id, variant_options')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .not('shopify_variant_id', 'is', null)
  const catalog = (products ?? []) as CatalogRow[]
  const { data: account } = await db.from('accounts').select('default_currency').eq('id', accountId).maybeSingle()
  const currency = (account?.default_currency as string | undefined) ?? 'GTQ'
  const lines = []
  if (args.accepted) {
    const byVariant = catalogVariantsById(catalog)
    const changes = args.accepted.lines.flatMap((l) => {
      const p = byVariant.get(l.variantId)
      if (!p) return [`un producto ya no está disponible (${l.variantId.split('/').pop()})`]
      lines.push({ variantId: l.variantId, quantity: l.quantity, price: l.price, title: p.name })
      return Math.abs(Number(p.price) - l.price) > 0.009 ? [`${p.name}: aceptó ${formatCurrency(l.price, args.accepted!.currency)}, hoy cuesta ${formatCurrency(Number(p.price), currency)}`] : []
    })
    if (args.accepted.currency !== currency) changes.push(`moneda ${args.accepted.currency} → ${currency}`)
    if (!args.accepted.lines.length) changes.push('la solicitud no tiene artículos aceptados')
    if (changes.length) {
      if (!byAgent) {
        try {
          await sendText('Gracias 🙏 Antes de registrar su pedido verificamos el precio y cambió desde su solicitud. Un asesor le escribe por aquí con el total actualizado para que lo confirme.')
        } catch (err) {
          console.error('[shopify] accepted-terms notice failed:', err)
        }
      }
      return handoff(`🛒 Solicitud de pedido no creada (${label}): cambió lo que el cliente aceptó — ${changes.join('; ')}. No se creó pedido ni link de pago: envíe el resumen actualizado y espere su nueva confirmación.`)
    }
  } else {
    for (const item of proposal.items) {
      const r = resolveCatalogVariant(catalog, item.name)
      if (!r.ok) {
        return fail(r.reason === 'missing_option'
          ? `"${item.name}": falta la talla/color exacta de ${r.product}; confírmela con el cliente`
          : r.reason === 'unavailable_option'
            ? `${r.product} está agotada; ofrezca otra talla/color`
            : `"${item.name}" no coincide con un producto activo de Shopify`)
      }
      lines.push({ variantId: r.variantId, quantity: item.qty, price: r.price, title: r.title })
    }
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

  lifecycle.starting()
  const order = await createShopifyOrder(cfg, {
      lines, currency,
      fullName: proposal.fullName, phone: proposal.phone, address: proposal.address,
      departamento: proposal.departamento, municipio: proposal.municipio, payment: proposal.payment,
      note: ['Pedido tomado por WhatsApp (Chat Sandía)', proposal.nit && `NIT: ${proposal.nit}`].filter(Boolean).join('\n'),
  })
  await lifecycle.created(order)

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
  // The customer accepted the catalog total. When Shopify prices the order
  // differently (price changed, discount, tax), neither confirm nor charge
  // the new amount on their behalf: a person re-quotes it.
  const catalogTotal = 'catalogTotal' in order && typeof order.catalogTotal === 'number' ? order.catalogTotal : order.total
  if (Math.abs(order.total - catalogTotal) > 0.009) {
    if (!byAgent) {
      try {
        await sendText('Gracias 🙏 Estamos verificando el total final de su pedido antes de confirmarlo. Un asesor le escribe por aquí en breve.')
      } catch (err) {
        console.error('[shopify] total-mismatch notice failed:', err)
      }
    }
    await handoff(`🛒 ${order.draft ? 'Borrador' : 'Pedido'} ${order.name} (${label}): Shopify calcula ${totalText} y el cliente aceptó ${formatCurrency(catalogTotal, currency)}. ` +
      'No se envió confirmación ni link de pago: confirme el total con el cliente antes de cobrar o despachar.')
    return { id: order.id, name: order.name, draft: order.draft, paymentLink: null }
  }
  let payLine = order.draft
    ? `Pago contra entrega: ${totalText}.`
    : `Pago contra entrega: ${totalText}. Número de pedido: *${order.name}* (para darle seguimiento).`
  let paymentLink: string | null = null
  if (proposal.payment === 'card') {
    // "Crear pedidos reales" off is the stop switch for new charges too: the
    // Recurrente key may be live, and with the switch off a paid link is
    // never completed automatically. A person sends the link if appropriate.
    if (cfg.recurrenteSecretKey && cfg.ordersLive) {
      try {
        const checkout = await createRecurrenteCheckout(cfg.recurrenteSecretKey, {
          // The customer sees this on Recurrente's page — the items, not a draft "#D3".
          title: label.slice(0, 120), total: order.total, currency, orderId: order.id,
        })
        paymentLink = checkout.url
        // Remembered so a paid link is found even if its webhook never arrives.
        if (checkout.id) await recordCardCheckout(db, accountId, { checkoutId: checkout.id, draftId: order.id, conversationId, amount: order.total, currency })
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
    const extra = [...new Set([proposal.municipio, proposal.departamento].filter((p): p is string => Boolean(p)))]
      .filter((p) => !proposal.address.toLowerCase().includes(p.toLowerCase()))
    const where = [proposal.address, ...extra].join(', ')
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

/** Pure: the lock key of a chat sale — the exact products (resolved to
 *  catalog variants when known), quantities, phone and payment. A marker the
 *  model re-emits for the same purchase ("gracias" after confirming, a
 *  reworded address) gets the same key; a different purchase gets another. */
export function chatPurchaseKey(
  proposal: Pick<NonNullable<GenerateResult['shopifyOrderProposal']>, 'items' | 'phone' | 'payment'>,
  variantOf: (name: string) => string | undefined,
): string {
  const items = new Map<string, number>()
  for (const i of proposal.items) {
    const id = variantOf(i.name) ?? `name:${i.name.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()}`
    items.set(id, (items.get(id) ?? 0) + i.qty)
  }
  const body = [...items].sort(([a], [b]) => a.localeCompare(b)).map(([id, qty]) => `${id}x${qty}`).join(',') +
    `|${normalizeGtPhone(proposal.phone)}|${proposal.payment}`
  return `chat:${createHash('sha256').update(body).digest('hex').slice(0, 32)}`
}

async function purchaseKeyFor(args: Parameters<typeof createShopifyOrderLocked>[0]): Promise<string> {
  if (args.requestId) return `request:${args.requestId}`
  const { data: products, error } = await args.db.from('products').select('name, price, shopify_variant_id, variant_options')
    .eq('account_id', args.accountId).eq('is_active', true).not('shopify_variant_id', 'is', null)
  if (error) throw new Error(`Cannot read products: ${error.message}`)
  const catalog = (products ?? []) as CatalogRow[]
  return chatPurchaseKey(args.proposal, (name) => {
    const r = resolveCatalogVariant(catalog, name)
    return r.ok ? r.variantId : undefined
  })
}

/** Serialize AI/manual creation across processes before contacting Shopify,
 * per PURCHASE: the same purchase is never placed twice within 24 h, a
 * different purchase in the same chat is allowed, and an attempt with an
 * unknown outcome keeps the whole chat blocked until a person checks Shopify. */
export async function createShopifyOrderFromChat(args: Parameters<typeof createShopifyOrderLocked>[0]) {
  const { db, accountId, conversationId } = args
  let purchaseKey: string
  try {
    purchaseKey = await purchaseKeyFor(args)
  } catch (err) {
    return args.handoff(`No se pudo identificar la compra; no se envió a Shopify: ${err instanceof Error ? err.message : String(err)}`)
  }
  const { data, error } = await db.rpc('claim_shopify_purchase_attempt', {
    p_account_id: accountId, p_conversation_id: conversationId, p_purchase_key: purchaseKey,
  })
  if (error) return args.handoff(`No se pudo bloquear la creación del pedido; no se envió a Shopify. Reintente cuando se recupere el servicio: ${error.message}`)
  const claim = data as { acquired: boolean; token?: string; status: string; orderName?: string | null } | null
  if (!claim?.acquired || !claim.token) {
    if (claim?.status === 'succeeded') {
      if (args.actor === 'agent') await args.handoff(`Este mismo pedido ya se creó en las últimas 24 horas${claim.orderName ? `: ${claim.orderName}` : ''}`)
    } else if (claim?.status === 'processing') {
      // Another worker owns it. Keep the first worker's conversation eligible;
      // an ordinary overlap must not turn into a human takeover.
      if (args.actor === 'agent') await args.handoff('Su pedido está en proceso. Espere a que termine antes de intentar otro.')
    } else {
      await args.handoff('Hay un pedido en proceso o con resultado pendiente de verificar en Shopify. Revise el pedido existente antes de intentar crear otro.')
    }
    return
  }
  const progress: { started: boolean; created: { id: string; name: string; draft: boolean } | null } = { started: false, created: null }
  const saveAttempt = async (status: 'succeeded' | 'failed' | 'blocked', lastError: string | null = null) => {
    const { data: saved, error: saveError } = await db.from('shopify_purchase_attempts').update({
      status, last_error: lastError,
      ...(progress.created ? { order_id: progress.created.id, order_name: progress.created.name, draft: progress.created.draft } : {}),
    }).eq('account_id', accountId).eq('purchase_key', purchaseKey).eq('attempt_token', claim.token)
      .select('attempt_token').maybeSingle()
    if (saveError || !saved) throw new Error(`Cannot save order attempt: ${saveError?.message || 'attempt no longer owned'}`)
  }
  try {
    const result = await createShopifyOrderLocked(args, {
      starting: () => { progress.started = true },
      created: async (order) => { progress.created = order; await saveAttempt('succeeded') },
    })
    if (!progress.started) await saveAttempt('failed')
    return result
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    try { await saveAttempt(progress.created ? 'succeeded' : progress.started ? 'blocked' : 'failed', reason) }
    catch (saveError) { console.error('[shopify] order attempt recovery state failed:', saveError) }
    await args.handoff(progress.started
      ? `El pedido ${progress.created ? `${progress.created.name} ya existe` : 'puede haberse creado'} en Shopify, pero no se completó su registro o respuesta. No cree otro sin revisarlo. ${reason}`
      : `Pedido no creado: ${reason}`)
  }
}
