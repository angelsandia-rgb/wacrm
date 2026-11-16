import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerateResult } from '@/lib/ai/types'
import { formatCurrency } from '@/lib/currency'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { coverageVerdict, departamentoCode, loadShopifyConfig, normalizeGtPhone, outOfStockTitles } from './api'
import { checkMunicipio } from './gt-geo'
import { ORDER_TEMPLATES } from './notify'
import { runOrderNotificationSweep, type OrderNotification } from './notification-jobs'

type Proposal = NonNullable<GenerateResult['shopifyOrderProposal']>

/** A request older than this is no longer waiting: the backlog check marks it
 *  'expired' and tells the team (src/lib/shopify/backlog.ts). */
// ponytail: no automatic customer reminder; a person recovers it (opt-out, hours, WhatsApp limits).
export const REQUEST_TTL_MS = 72 * 3600_000
/** More waiting purchases than this for one contact is not a conversation the model can sort out. */
const MAX_WAITING = 5
/** The stored send time of the summary can trail the message row by a moment. */
const QUOTE_SLACK_MS = 60_000
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
  /** One per submit intent: a retry of the same submit must not ask twice. */
  idempotencyKey: string
  /** Set when the form edits a purchase still waiting for its "sí". */
  purchaseId: string
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
    idempotencyKey: /^[A-Za-z0-9_-]{8,64}$/.test(String(b.idempotencyKey ?? '')) ? String(b.idempotencyKey) : '',
    purchaseId: UUID_RE.test(String(b.purchaseId ?? '')) ? String(b.purchaseId) : '',
  }
  if (input.fullName.length < 3) return { error: 'Escriba su nombre completo.' }
  if (normalizeGtPhone(input.phone).replace(/\D/g, '').length !== 11) return { error: 'Escriba un teléfono de 8 dígitos.' }
  if (input.address.length < 5) return { error: 'Escriba su dirección.' }
  if (!departamentoCode(input.departamento)) return { error: 'Elija su departamento.' }
  const place = checkMunicipio(input.municipio, input.departamento)
  if (!place.ok) {
    return { error: place.departamentos.length
      ? `${input.municipio} pertenece a ${place.departamentos.join(' o ')}, no a ${input.departamento}. Elija el departamento correcto.`
      : `Elija su municipio de la lista de ${input.departamento}.` }
  }
  // Stored as the canonical names, whatever the accents or case typed.
  return { ...input, municipio: place.municipio, departamento: place.departamento }
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
  const terms: AcceptedTerms = { lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, price: l.price })), currency, total }

  const firstName = input.fullName.split(' ')[0]
  const totalText = formatCurrency(total, currency)
  const summary = requestSummary(proposal)
  const card = input.payment === 'card'
  const ask: OrderNotification = {
    conversationId,
    text: `¡Hola ${firstName}! Recibimos su pedido:\n${lines.map((l) => `• ${l.quantity} x ${l.title}`).join('\n')}\n` +
      `Total: ${totalText}, ${card ? 'pago con tarjeta' : 'pago contra entrega'}.\nEntrega en: ${[address, input.municipio, input.departamento].join(', ')}.\n\n` +
      (card
        ? '¿Confirma su pedido? Responda *SÍ* y le enviamos su link de pago seguro.'
        : '¿Confirma su pedido? Responda *SÍ* y lo preparamos para envío. Si prefiere pagar con tarjeta, díganos y le enviamos un link seguro.'),
    // confirmar_pedido: "recibimos su pedido {{2}} en Casa Ceiba por {{3}}".
    template: { names: card ? ORDER_TEMPLATES.confirmCard : ORDER_TEMPLATES.confirm, params: [firstName, `de ${summary}`, totalText] },
  }
  // The request (a new purchase, or the next revision of the one being
  // edited) and its WhatsApp question are saved in one transaction. A second
  // purchase by the same contact is a second purchase, not a replacement.
  const submit = () => db.rpc('submit_shopify_order_request', {
    p_account_id: accountId, p_contact_id: contactId, p_conversation_id: conversationId,
    p_proposal: proposal, p_total: total, p_currency: currency, p_terms: terms,
    p_idempotency_key: input.idempotencyKey || null, p_purchase_id: input.purchaseId || null, p_job_payload: ask,
  })
  let { data: saved, error: submitError } = await submit()
  // The same submit raced itself (double click, two tabs): the retry finds
  // the row the winner created and returns it.
  if (submitError && input.idempotencyKey) ({ data: saved, error: submitError } = await submit())
  if (submitError) {
    if (/Purchase is not editable/.test(submitError.message)) {
      return { error: 'Ese pedido ya no se puede cambiar desde aquí. Escríbanos por WhatsApp y le ayudamos.', status: 409 }
    }
    throw new Error(`Cannot save order request: ${submitError.message}`)
  }
  const request = saved as { id: string; created: boolean }
  // A repeated submit asked already: nothing more to send.
  if (request.created) await runOrderNotificationSweep(db, accountId, `request:${request.id}:ask`)
  return { ok: true }
}

/** Pure: "2 x Lámpara, 1 x Foco" for messages and the AI prompt. */
export function requestSummary(p: Pick<Proposal, 'items'>): string {
  return p.items.map((i) => `${i.qty} x ${i.name}`).join(', ')
}

export interface PendingOrderRequest {
  id: string; proposal: Proposal; summary: string; terms: AcceptedTerms | null
  /** Short code the model must quote when several purchases wait at once. */
  ref: string
  /** When the summary reached WhatsApp; null = not delivered, cannot be accepted yet. */
  askDeliveredAt: string | null
}

/** Every purchase of this contact still waiting for their WhatsApp answer
 *  (newest first). Two purchases can wait at once: each is its own purchase. */
export async function loadPendingOrderRequests(db: SupabaseClient, accountId: string, contactId: string): Promise<PendingOrderRequest[]> {
  const { data, error } = await db.from('shopify_order_requests').select('id, purchase_id, proposal, total, currency, terms, ask_delivered_at')
    .eq('account_id', accountId).eq('contact_id', contactId).eq('status', 'pending')
    .gte('created_at', new Date(Date.now() - REQUEST_TTL_MS).toISOString())
    .order('created_at', { ascending: false }).limit(MAX_WAITING)
  if (error) throw error
  return (data ?? []).map((row) => {
    const proposal = row.proposal as Proposal
    return {
      id: row.id as string, proposal, terms: (row.terms as AcceptedTerms | null) ?? null,
      ref: String(row.purchase_id).replace(/-/g, '').slice(0, 4).toUpperCase(),
      askDeliveredAt: (row.ask_delivered_at as string | null) ?? null,
      summary: `${requestSummary(proposal)}; total ${formatCurrency(Number(row.total), row.currency as string)}; entrega en ${[proposal.address, proposal.municipio, proposal.departamento].filter(Boolean).join(', ')}`,
    }
  })
}

/** What the customer's last message answers: when it arrived and, if they
 *  quoted a message, when that one was sent. */
export interface InboundContext { at: string; quotedAt: string | null }

export async function loadInboundContext(db: SupabaseClient, conversationId: string): Promise<InboundContext | null> {
  const { data: last, error } = await db.from('messages').select('created_at, reply_to_message_id')
    .eq('conversation_id', conversationId).eq('sender_type', 'customer')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw error
  if (!last) return null
  let quotedAt: string | null = null
  if (last.reply_to_message_id) {
    const { data: quoted, error: quotedError } = await db.from('messages').select('created_at').eq('id', last.reply_to_message_id).maybeSingle()
    if (quotedError) throw quotedError
    quotedAt = (quoted?.created_at as string | undefined) ?? null
  }
  return { at: last.created_at as string, quotedAt }
}

/** Pure: the ONE purchase a confirm/cancel answer refers to, or null when it
 *  cannot be told — the model then asks instead of the server guessing.
 *  "The contact's latest pending request" is not proof of consent:
 *   - a summary that never reached WhatsApp cannot have been accepted;
 *   - with several purchases waiting, the answer must name one (its ref);
 *   - an answer quoting a message older than the current summary is about
 *     something else (an earlier version, another topic). */
export function pickAnsweredRequest(pending: PendingOrderRequest[], ref: string | null | undefined, inbound: InboundContext | null): PendingOrderRequest | null {
  if (!inbound) return null
  const delivered = pending.filter((r) => r.askDeliveredAt && Date.parse(r.askDeliveredAt) <= Date.parse(inbound.at))
  const wanted = ref?.trim().toUpperCase()
  const picked = wanted ? delivered.filter((r) => r.ref === wanted) : pending.length === 1 ? delivered : []
  if (picked.length !== 1) return null
  if (inbound.quotedAt && Date.parse(inbound.quotedAt) < Date.parse(picked[0].askDeliveredAt!) - QUOTE_SLACK_MS) return null
  return picked[0]
}

/** Pure: how the waiting purchases are described to the model. */
export function pendingRequestsPrompt(pending: PendingOrderRequest[]): string | null {
  const line = (r: PendingOrderRequest) => r.summary + (r.proposal.payment === 'card' ? '; they chose to pay BY CARD in the form' : '')
  if (!pending.length) return null
  if (pending.length === 1) return line(pending[0])
  return `SEVERAL separate purchases, each with its reference code: ${pending.map((r) => `[${r.ref}] ${line(r)}`).join(' | ')}`
}

/** Atomically take a pending request: 'processing' (the customer said yes,
 *  creation starts) or 'cancelled'. False when another worker already did
 *  (a duplicate answer must never place a second order). */
export async function settleOrderRequest(db: SupabaseClient, accountId: string, id: string, status: 'processing' | 'cancelled' | 'superseded'): Promise<boolean> {
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
