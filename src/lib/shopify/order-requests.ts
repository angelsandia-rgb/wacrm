import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerateResult } from '@/lib/ai/types'
import { formatCurrency } from '@/lib/currency'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { coverageVerdict, departamentoCode, loadShopifyConfig, municipioMatchesDepartamento, normalizeGtPhone, outOfStockTitles } from './api'
import { ORDER_TEMPLATES } from './notify'
import { enqueueOrderNotification, runOrderNotificationSweep } from './notification-jobs'

type Proposal = NonNullable<GenerateResult['shopifyOrderProposal']>

/** A request older than this is no longer waiting: the backlog check marks it
 *  'expired' and tells the team (src/lib/shopify/backlog.ts). */
// ponytail: no automatic customer reminder; a person recovers it (opt-out, hours, WhatsApp limits).
export const REQUEST_TTL_MS = 72 * 3600_000
const MAX_LINES = 10
const MAX_QTY = 20

/** What the customer accepted. The order is placed with these exact prices
 *  or not at all (see createShopifyOrderFromChat). */
export interface AcceptedTerms {
  lines: { variantId: string; quantity: number; price: number }[]
  currency: string
  total: number
}

export interface OrderFormInput {
  items: { variantId: string; quantity: number }[]
  fullName: string
  phone: string
  address: string
  reference: string
  municipio: string
  departamento: string
  nit: string
  payment: 'cod' | 'card'
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const variantGid = (id: string) => (id.startsWith('gid://') ? id : `gid://shopify/ProductVariant/${id}`)

/** Pure: the form body → a clean input, or the reason it is rejected
 *  (shown to the customer, in Spanish). */
export function parseOrderForm(body: unknown): OrderFormInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_LINES + 1).map((i) => {
    const r = (i ?? {}) as Record<string, unknown>
    return { variantId: String(r.variantId ?? '').trim(), quantity: Math.floor(Number(r.quantity)) }
  })
  if (!items.length || items.length > MAX_LINES || items.some((i) => !/^(gid:\/\/shopify\/ProductVariant\/)?\d+$/.test(i.variantId) || !(i.quantity >= 1 && i.quantity <= MAX_QTY))) {
    return { error: 'Revise los productos y las cantidades.' }
  }
  const input = {
    items, fullName: text(b.fullName, 120), phone: text(b.phone, 30), address: text(b.address, 200),
    reference: text(b.reference, 200), municipio: text(b.municipio, 80), departamento: text(b.departamento, 40),
    nit: text(b.nit, 20), payment: b.payment === 'card' ? 'card' as const : 'cod' as const,
  }
  if (input.fullName.length < 3) return { error: 'Escriba su nombre completo.' }
  if (normalizeGtPhone(input.phone).replace(/\D/g, '').length !== 11) return { error: 'Escriba un teléfono de 8 dígitos.' }
  if (input.address.length < 5) return { error: 'Escriba su dirección.' }
  if (!departamentoCode(input.departamento)) return { error: 'Elija su departamento.' }
  if (!input.municipio || !municipioMatchesDepartamento(input.municipio, input.departamento)) {
    return { error: `Revise el municipio: no corresponde a ${input.departamento}.` }
  }
  return input
}

/** Save the request and ask the customer on WhatsApp. No Shopify order is
 *  created here: it is created on their "sí" (see the AI order markers). */
export async function submitOrderForm(db: SupabaseClient, accountId: string, input: OrderFormInput): Promise<{ ok: true } | { error: string; status: number }> {
  const cfg = await loadShopifyConfig(db, accountId)
  if (!cfg) return { error: 'La tienda no acepta pedidos por este medio.', status: 404 }
  if (coverageVerdict(cfg.shippingCoverage, input.departamento, input.municipio) !== 'ok') {
    return { error: `Por ahora no hacemos envíos a ${input.municipio}, ${input.departamento}. Escríbanos por WhatsApp y le ayudamos.`, status: 422 }
  }

  const ids = [...new Set(input.items.map((i) => variantGid(i.variantId)))]
  const { data: products, error: productsError } = await db.from('products').select('name, price, shopify_variant_id')
    .eq('account_id', accountId).eq('is_active', true).in('shopify_variant_id', ids)
  if (productsError) throw productsError
  const byVariant = new Map((products ?? []).map((p) => [p.shopify_variant_id as string, p]))
  const lines = []
  for (const item of input.items) {
    const p = byVariant.get(variantGid(item.variantId))
    if (!p) return { error: 'Uno de los productos ya no está disponible. Actualice la página.', status: 409 }
    lines.push({ variantId: p.shopify_variant_id as string, quantity: item.quantity, title: p.name as string, price: Number(p.price) })
  }
  const missing = await outOfStockTitles(cfg, lines)
  if (missing.length) return { error: `Sin existencias por ahora: ${missing.join(', ')}.`, status: 409 }

  const { data: account } = await db.from('accounts').select('default_currency').eq('id', accountId).maybeSingle()
  const currency = (account?.default_currency as string | undefined) ?? 'GTQ'
  const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0)
  const phone = normalizeGtPhone(input.phone)
  const address = [input.address, input.reference && `Ref.: ${input.reference}`].filter(Boolean).join('. ')
  const proposal: Proposal = {
    items: lines.map((l) => ({ name: l.title, qty: l.quantity })),
    fullName: input.fullName, phone, address, departamento: input.departamento, municipio: input.municipio, payment: input.payment,
    ...(input.nit && { nit: input.nit }),
  }

  const { contactId, conversationId } = await resolveConversationByPhone(db, accountId, phone, input.fullName)
  // One pending request per contact: the latest form wins.
  const { error: supersedeError } = await db.from('shopify_order_requests').update({ status: 'superseded', decided_at: new Date().toISOString() })
    .eq('account_id', accountId).eq('contact_id', contactId).eq('status', 'pending')
  if (supersedeError) throw supersedeError
  const terms: AcceptedTerms = { lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, price: l.price })), currency, total }
  const { data: request, error: insertError } = await db.from('shopify_order_requests').insert({
    account_id: accountId, contact_id: contactId, conversation_id: conversationId, proposal, total, currency, terms,
  }).select('id').single()
  if (insertError) throw insertError

  const firstName = input.fullName.split(' ')[0]
  const totalText = formatCurrency(total, currency)
  const summary = requestSummary(proposal)
  const card = input.payment === 'card'
  const eventKey = `request:${request.id}:ask`
  await enqueueOrderNotification(db, accountId, eventKey, {
    conversationId,
    text: `¡Hola ${firstName}! Recibimos su pedido:\n${lines.map((l) => `• ${l.quantity} x ${l.title}`).join('\n')}\n` +
      `Total: ${totalText}, ${card ? 'pago con tarjeta' : 'pago contra entrega'}.\nEntrega en: ${[address, input.municipio, input.departamento].join(', ')}.\n\n` +
      (card
        ? '¿Confirma su pedido? Responda *SÍ* y le enviamos su link de pago seguro.'
        : '¿Confirma su pedido? Responda *SÍ* y lo preparamos para envío. Si prefiere pagar con tarjeta, díganos y le enviamos un link seguro.'),
    // confirmar_pedido: "recibimos su pedido {{2}} en Casa Ceiba por {{3}}".
    template: { names: card ? ORDER_TEMPLATES.confirmCard : ORDER_TEMPLATES.confirm, params: [firstName, `de ${summary}`, totalText] },
  })
  await runOrderNotificationSweep(db, accountId, eventKey)
  return { ok: true }
}

/** Pure: "2 x Lámpara, 1 x Foco" for messages and the AI prompt. */
export function requestSummary(p: Pick<Proposal, 'items'>): string {
  return p.items.map((i) => `${i.qty} x ${i.name}`).join(', ')
}

export interface PendingOrderRequest { id: string; proposal: Proposal; summary: string; terms: AcceptedTerms | null }

/** The contact's form request still waiting for their WhatsApp answer. */
export async function loadPendingOrderRequest(db: SupabaseClient, accountId: string, contactId: string): Promise<PendingOrderRequest | null> {
  const { data, error } = await db.from('shopify_order_requests').select('id, proposal, total, currency, terms')
    .eq('account_id', accountId).eq('contact_id', contactId).eq('status', 'pending')
    .gte('created_at', new Date(Date.now() - REQUEST_TTL_MS).toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw error
  if (!data) return null
  const proposal = data.proposal as Proposal
  return {
    id: data.id as string, proposal, terms: (data.terms as AcceptedTerms | null) ?? null,
    summary: `${requestSummary(proposal)}; total ${formatCurrency(Number(data.total), data.currency as string)}; entrega en ${[proposal.address, proposal.municipio, proposal.departamento].filter(Boolean).join(', ')}`,
  }
}

/** Atomically take a pending request: 'processing' (the customer said yes,
 *  creation starts) or 'cancelled'. False when another worker already did
 *  (a duplicate answer must never place a second order). */
export async function settleOrderRequest(db: SupabaseClient, accountId: string, id: string, status: 'processing' | 'cancelled'): Promise<boolean> {
  const { data, error } = await db.from('shopify_order_requests').update({ status, decided_at: new Date().toISOString() })
    .eq('account_id', accountId).eq('id', id).eq('status', 'pending').select('id').maybeSingle()
  if (error) throw error
  return Boolean(data)
}

/** Close a 'processing' request: the order it produced, or 'held' with the
 *  reason a person must reconcile it. Never back to pending — a request whose
 *  Shopify result is unknown must not be placed again. */
export async function finishOrderRequest(db: SupabaseClient, accountId: string, id: string,
  outcome: { status: 'confirmed'; orderId: string; orderName: string } | { status: 'held'; note: string }): Promise<void> {
  const { error } = await db.from('shopify_order_requests').update(outcome.status === 'confirmed'
    ? { status: 'confirmed', order_id: outcome.orderId, order_name: outcome.orderName }
    : { status: 'held', outcome_note: outcome.note.slice(0, 500) })
    .eq('account_id', accountId).eq('id', id).eq('status', 'processing')
  if (error) throw error
}
