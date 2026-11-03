import { createHmac, timingSafeEqual } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

// Shopify Admin GraphQL (Settings → Shopify, migrations 173/175): a static
// shpat_ token from a legacy custom app, or a Dev Dashboard app's Client ID +
// secret traded for a 24 h token. The app needs read_products, read_inventory, read_orders,
// write_orders and write_draft_orders.
const API_VERSION = '2026-10'

export const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

/** The store's manual payment methods, verbatim — the order's
 *  payment_gateway_names come from the transaction `gateway`, and the
 *  team/Dropify read them to know whether to collect cash on delivery. */
export const PAYMENT_GATEWAYS = {
  cod: 'Pago contra entrega (COD)',
  card: 'Tarjeta de crédito o débito (link de pago por WhatsApp)',
} as const
export type PaymentMethod = keyof typeof PAYMENT_GATEWAYS

export const ORDER_TAG = 'chat-sandia'
export const CARD_TAG = 'pago-tarjeta'

export class ShopifyError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

export interface ShopifyConfig {
  shop: string
  token: string
  ordersLive: boolean
  webhookSecret: string | null
  templateName: string | null
  templateLanguage: string
  recurrenteSecretKey: string | null
  /** Svix signing secret (whsec_…) of the Recurrente webhook that completes paid card drafts. */
  recurrenteWebhookSecret: string | null
  /** Dev Dashboard apps only: fetches a fresh token (and caches it), used on a 401. */
  refreshToken?: () => Promise<string>
}

/** Client-credentials grant for Dev Dashboard apps. The app and the store
 *  must be in the same Shopify organization and the app installed on it. */
export async function fetchClientCredentialsToken(
  shop: string,
  clientId: string,
  clientSecret: string,
): Promise<{ token: string; expiresAt: Date }> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    | null
  if (json?.error === 'shop_not_permitted') {
    throw new ShopifyError('Shopify no permite esta app en la tienda: la app y la tienda deben estar en la misma organización de Shopify y la app debe estar instalada en la tienda', 400)
  }
  if (!res.ok || !json?.access_token) {
    throw new ShopifyError(
      res.status === 400 || res.status === 401
        ? 'Shopify rechazó el Client ID o el Client secret'
        : json?.error_description || json?.error || `Shopify HTTP ${res.status}`,
      400,
    )
  }
  return { token: json.access_token, expiresAt: new Date(Date.now() + (json.expires_in ?? 86_399) * 1000) }
}

/** Decrypted config for `accountId`, or null when no store is connected.
 *  For client-credentials apps the cached token is refreshed ~60 s before
 *  it expires and written back encrypted. */
export async function loadShopifyConfig(db: SupabaseClient, accountId: string): Promise<ShopifyConfig | null> {
  const { data } = await db
    .from('shopify_config')
    .select('shop_domain, access_token, access_token_expires_at, client_id, client_secret, webhook_secret, orders_live, confirmation_template_name, confirmation_template_language, recurrente_secret_key, recurrente_webhook_secret')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data) return null
  const cfg: ShopifyConfig = {
    shop: data.shop_domain as string,
    token: decrypt(data.access_token as string),
    ordersLive: Boolean(data.orders_live),
    webhookSecret: data.webhook_secret ? decrypt(data.webhook_secret as string) : null,
    templateName: (data.confirmation_template_name as string | null) || null,
    templateLanguage: (data.confirmation_template_language as string | null) || 'es',
    recurrenteSecretKey: data.recurrente_secret_key ? decrypt(data.recurrente_secret_key as string) : null,
    recurrenteWebhookSecret: data.recurrente_webhook_secret ? decrypt(data.recurrente_webhook_secret as string) : null,
  }
  if (data.client_id && data.client_secret) {
    const clientId = data.client_id as string
    const clientSecret = decrypt(data.client_secret as string)
    cfg.refreshToken = async () => {
      const { token, expiresAt } = await fetchClientCredentialsToken(cfg.shop, clientId, clientSecret)
      cfg.token = token
      // Best effort: a caller without write access still uses the fresh token.
      const { error } = await db.from('shopify_config')
        .update({ access_token: encrypt(token), access_token_expires_at: expiresAt.toISOString() })
        .eq('account_id', accountId)
      if (error) console.warn('[shopify] could not cache token:', error.message)
      return token
    }
    const expiresAt = data.access_token_expires_at ? Date.parse(data.access_token_expires_at as string) : 0
    if (expiresAt - Date.now() < 60_000) await cfg.refreshToken()
  }
  return cfg
}

export async function shopifyGraphql<T>(
  cfg: Pick<ShopifyConfig, 'shop' | 'token' | 'refreshToken'>,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const post = () => fetch(`https://${cfg.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': cfg.token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  let res = await post()
  if (res.status === 401 && cfg.refreshToken) {
    cfg.token = await cfg.refreshToken()
    res = await post()
  }
  if (res.status === 401 || res.status === 403) throw new ShopifyError('Shopify rechazó el token (revisa permisos de la app)', 401)
  const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null
  if (!res.ok || !json || json.errors?.length || !json.data) {
    throw new ShopifyError(json?.errors?.map((e) => e.message).join('; ') || `Shopify HTTP ${res.status}`)
  }
  return json.data
}

// ---------------------------------------------------------------- products

interface ShopifyProductNode {
  title: string
  description: string
  featuredMedia: { preview: { image: { url: string } | null } | null } | null
  variants: {
    nodes: {
      id: string
      price: string
      inventoryQuantity: number | null
      inventoryPolicy: 'DENY' | 'CONTINUE'
      inventoryItem: { tracked: boolean } | null
    }[]
  }
}

export interface SyncedProduct {
  shopify_variant_id: string
  name: string
  price: number
  description: string | null
  image_url: string | null
  is_active: boolean
}

/** Pure mapping: one catalog row per Shopify product (its first variant).
 *  Out-of-stock tracked variants that don't allow overselling are inactive. */
export function mapShopifyProduct(p: ShopifyProductNode): SyncedProduct | null {
  // ponytail: first variant only — the store sells single-variant products; one row per variant when that changes.
  const v = p.variants.nodes[0]
  if (!v) return null
  const tracked = v.inventoryItem?.tracked ?? false
  const inStock = !tracked || v.inventoryPolicy === 'CONTINUE' || (v.inventoryQuantity ?? 0) > 0
  const desc = p.description.replace(/\s+/g, ' ').trim()
  return {
    shopify_variant_id: v.id,
    name: p.title.trim(),
    price: Number(v.price) || 0,
    description: desc ? desc.slice(0, 300) : null,
    image_url: p.featuredMedia?.preview?.image?.url ?? null,
    is_active: inStock,
  }
}

const PRODUCTS_QUERY = `query($cursor: String) {
  products(first: 100, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      title
      description(truncateAt: 400)
      featuredMedia { preview { image { url } } }
      variants(first: 1) { nodes { id price inventoryQuantity inventoryPolicy inventoryItem { tracked } } }
    }
  }
}`

/** Pull active Shopify products into `products` (matched by
 *  shopify_variant_id). Previously-synced rows that are no longer active
 *  in Shopify are deactivated, never deleted (quotes may reference them). */
export async function syncShopifyProducts(db: SupabaseClient, accountId: string, userId: string) {
  const cfg = await loadShopifyConfig(db, accountId)
  if (!cfg) throw new ShopifyError('Shopify no está conectado', 400)

  const synced: SyncedProduct[] = []
  let cursor: string | null = null
  do {
    const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyProductNode[] } } =
      await shopifyGraphql(cfg, PRODUCTS_QUERY, { cursor })
    for (const node of data.products.nodes) {
      const row = mapShopifyProduct(node)
      if (row) synced.push(row)
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null
  } while (cursor)

  const { data: existing, error } = await db
    .from('products')
    .select('id, shopify_variant_id')
    .eq('account_id', accountId)
    .not('shopify_variant_id', 'is', null)
  if (error) throw new ShopifyError(error.message, 500)
  const idByVariant = new Map((existing ?? []).map((r) => [r.shopify_variant_id as string, r.id as string]))

  for (const row of synced) {
    const id = idByVariant.get(row.shopify_variant_id)
    const { error: writeError } = id
      ? await db.from('products').update(row).eq('id', id).eq('account_id', accountId)
      : await db.from('products').insert({ ...row, account_id: accountId, user_id: userId })
    if (writeError) throw new ShopifyError(writeError.message, 500)
  }

  const live = new Set(synced.map((r) => r.shopify_variant_id))
  const gone = [...idByVariant].filter(([variant]) => !live.has(variant)).map(([, id]) => id)
  if (gone.length) {
    await db.from('products').update({ is_active: false }).eq('account_id', accountId).in('id', gone)
  }
  await db.from('shopify_config').update({ last_sync_at: new Date().toISOString() }).eq('account_id', accountId)

  return { synced: synced.length, active: synced.filter((r) => r.is_active).length, deactivated: gone.length }
}

// ------------------------------------------------------------------ orders

export interface OrderRequest {
  lines: { variantId: string; quantity: number; price: number; title: string }[]
  fullName: string
  phone: string
  address: string
  departamento: string
  payment: PaymentMethod
  currency: string
  note?: string
}

function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/)
  return { firstName: parts.slice(0, -1).join(' ') || parts[0], lastName: parts.length > 1 ? parts[parts.length - 1] : '' }
}

/** Guatemala local numbers (8 digits) get +502; anything else is passed through as E.164-ish. */
export function normalizeGtPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  // ponytail: GT-only default country; read accounts.default_country when a second country sells.
  if (digits.length === 8) return `+502${digits}`
  return digits ? `+${digits}` : ''
}

// Shopify's Guatemala zone codes, keyed by accent-free lowercase name.
const GT_DEPARTAMENTOS: Record<string, string> = {
  'alta verapaz': 'AVE', 'baja verapaz': 'BVE', chimaltenango: 'CMT', chiquimula: 'CQM',
  'el progreso': 'EPR', escuintla: 'ESC', guatemala: 'GUA', huehuetenango: 'HUE', izabal: 'IZA',
  jalapa: 'JAL', jutiapa: 'JUT', peten: 'PET', quetzaltenango: 'QUE', quiche: 'QUI', 'el quiche': 'QUI',
  retalhuleu: 'RET', sacatepequez: 'SAC', 'san marcos': 'SMA', 'santa rosa': 'SRO', solola: 'SOL',
  suchitepequez: 'SUC', totonicapan: 'TOT', zacapa: 'ZAC',
}

export function departamentoCode(name: string): string | undefined {
  return GT_DEPARTAMENTOS[name.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()]
}

/** Pure: the `orderCreate` input for a confirmed chat order. */
export function buildOrderInput(req: OrderRequest) {
  const total = req.lines.reduce((s, l) => s + l.price * l.quantity, 0)
  const money = (amount: number) => ({ shopMoney: { amount: amount.toFixed(2), currencyCode: req.currency } })
  const phone = normalizeGtPhone(req.phone)
  const address = {
    ...splitName(req.fullName),
    address1: req.address,
    city: req.departamento,
    provinceCode: departamentoCode(req.departamento),
    countryCode: 'GT',
    phone,
  }
  return {
    currency: req.currency,
    phone,
    lineItems: req.lines.map((l) => ({
      variantId: l.variantId, quantity: l.quantity, priceSet: money(l.price), requiresShipping: true,
    })),
    shippingAddress: address,
    billingAddress: address,
    shippingLines: [{ title: 'Envío gratis', priceSet: money(0) }],
    financialStatus: 'PENDING',
    transactions: [{ kind: 'SALE', status: 'PENDING', gateway: PAYMENT_GATEWAYS[req.payment], amountSet: money(total) }],
    tags: req.payment === 'card' ? [ORDER_TAG, CARD_TAG] : [ORDER_TAG],
    sourceName: ORDER_TAG,
    note: req.note,
  }
}

const ORDER_CREATE = `mutation($order: OrderCreateOrderInput!) {
  orderCreate(order: $order, options: { inventoryBehaviour: DECREMENT_OBEYING_POLICY, sendReceipt: false }) {
    order { id name }
    userErrors { field message }
  }
}`

const DRAFT_ORDER_CREATE = `mutation($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id name }
    userErrors { field message }
  }
}`

/** Creates the Shopify order — a real one (→ Dropify → Dropi) only when
 *  the account turned `orders_live` on AND it's cash on delivery.
 *  Otherwise a draft order a human completes from Shopify admin: card
 *  orders always stay drafts until the Recurrente payment is confirmed,
 *  because a pending real order would ship right away and Dropi would
 *  collect it as cash on delivery. */
export async function createShopifyOrder(cfg: ShopifyConfig, req: OrderRequest) {
  const input = buildOrderInput(req)
  const total = req.lines.reduce((s, l) => s + l.price * l.quantity, 0)
  if (cfg.ordersLive && req.payment === 'cod') {
    const data = await shopifyGraphql<{ orderCreate: { order: { id: string; name: string } | null; userErrors: { message: string }[] } }>(
      cfg, ORDER_CREATE, { order: input },
    )
    const r = data.orderCreate
    if (!r.order) throw new ShopifyError(r.userErrors.map((e) => e.message).join('; ') || 'orderCreate failed', 422)
    return { id: r.order.id, name: r.order.name, draft: false, total }
  }
  const data = await shopifyGraphql<{ draftOrderCreate: { draftOrder: { id: string; name: string } | null; userErrors: { message: string }[] } }>(
    cfg, DRAFT_ORDER_CREATE, {
      input: {
        phone: input.phone,
        lineItems: req.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        shippingAddress: input.shippingAddress,
        billingAddress: input.billingAddress,
        shippingLine: { title: 'Envío gratis', priceWithCurrency: { amount: '0.00', currencyCode: req.currency } },
        tags: input.tags,
        note: [`Pago: ${PAYMENT_GATEWAYS[req.payment]}`, req.note].filter(Boolean).join('\n'),
      },
    },
  )
  const r = data.draftOrderCreate
  if (!r.draftOrder) throw new ShopifyError(r.userErrors.map((e) => e.message).join('; ') || 'draftOrderCreate failed', 422)
  return { id: r.draftOrder.id, name: r.draftOrder.name, draft: true, total }
}

// ------------------------------------------------------------------- deals

/** Point the contact's open deal at this order (or open one in the
 *  account's oldest pipeline, first stage). Same resolution createQuote uses. */
export async function attachOrderToDeal(args: {
  db: SupabaseClient; accountId: string; userId: string; contactId: string
  order: { id: string; name: string; total: number }; currency: string
}): Promise<string | null> {
  const { db, accountId, userId, contactId, order, currency } = args
  const fields = { title: `Pedido Shopify ${order.name}`, value: order.total, shopify_order_id: order.id }
  const { data: open } = await db
    .from('deals').select('id')
    .eq('account_id', accountId).eq('contact_id', contactId).eq('status', 'open')
    .order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (open) {
    await db.from('deals').update(fields).eq('id', open.id).eq('account_id', accountId)
    return open.id as string
  }
  const { data: pipeline } = await db
    .from('pipelines').select('id').eq('account_id', accountId)
    .order('created_at', { ascending: true }).limit(1).maybeSingle()
  if (!pipeline) return null
  const { data: stage } = await db
    .from('pipeline_stages').select('id').eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true }).limit(1).maybeSingle()
  if (!stage) return null
  const { data: deal, error } = await db.from('deals').insert({
    ...fields, account_id: accountId, user_id: userId, pipeline_id: pipeline.id, stage_id: stage.id,
    contact_id: contactId, currency, status: 'open',
  }).select('id').single()
  if (error) {
    console.error('[shopify] deal insert failed:', error.message)
    return null
  }
  return deal.id as string
}

// ---------------------------------------------------------------- webhooks

/** Shopify signs webhooks with base64 HMAC-SHA256 of the raw body. */
export function verifyShopifyHmac(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64'))
  const got = Buffer.from(header)
  return got.length === expected.length && timingSafeEqual(got, expected)
}

// ------------------------------------------------------------ order status

export interface OrderStatus {
  name: string
  createdAt: string
  cancelledAt: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string
  phone: string | null
  shippingAddress: { phone: string | null } | null
  fulfillments: { displayStatus: string | null; trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[]
}

const ORDER_FIELDS = `name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus phone
  shippingAddress { phone }
  fulfillments(first: 5) { displayStatus trackingInfo { company number url } }`

const digitsTail = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '').slice(-8)

/**
 * The customer's orders for an order-status question: the ones linked to
 * their deals (chat + web-store orders), plus any `#1234` they typed —
 * but only when that order's phone matches theirs, so a guessed number
 * never reveals someone else's order. Dropi's tracking reaches us through
 * the Shopify fulfillment Dropify writes back.
 */
export async function loadOrderStatuses(args: {
  db: SupabaseClient; accountId: string; contactId: string; contactPhone: string; text: string
}): Promise<OrderStatus[]> {
  const { db, accountId, contactId, contactPhone, text } = args
  const cfg = await loadShopifyConfig(db, accountId)
  if (!cfg) return []
  const { data: deals } = await db
    .from('deals').select('shopify_order_id')
    .eq('account_id', accountId).eq('contact_id', contactId).not('shopify_order_id', 'is', null)
    .order('updated_at', { ascending: false }).limit(3)
  // Drafts (gid://shopify/DraftOrder/…) aren't orders yet; nothing to track.
  const ids = (deals ?? []).map((d) => d.shopify_order_id as string).filter((id) => id.includes('/Order/'))
  const found: OrderStatus[] = []
  if (ids.length) {
    const data = await shopifyGraphql<{ nodes: (OrderStatus | null)[] }>(
      cfg, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } } }`, { ids },
    )
    found.push(...data.nodes.filter((n): n is OrderStatus => Boolean(n?.name)))
  }
  const number = text.match(/#\s?(\d{3,})/)?.[1]
  if (number && !found.some((o) => o.name === `#${number}`)) {
    const data = await shopifyGraphql<{ orders: { nodes: OrderStatus[] } }>(
      cfg, `query($q: String!) { orders(first: 1, query: $q) { nodes { ${ORDER_FIELDS} } } }`, { q: `name:#${number}` },
    )
    const order = data.orders.nodes[0]
    const mine = digitsTail(contactPhone)
    if (order && mine && [order.phone, order.shippingAddress?.phone].some((p) => digitsTail(p) === mine)) found.push(order)
  }
  return found
}

/** One prompt line per order — data for the model, not instructions. */
export function describeOrderStatuses(orders: OrderStatus[]): string {
  return orders.map((o) => {
    const tracking = o.fulfillments.flatMap((f) => f.trackingInfo.map((t) => [t.company, t.number, t.url].filter(Boolean).join(' ')))
      .filter(Boolean)
    const delivery = o.fulfillments.map((f) => f.displayStatus).filter(Boolean).join(', ')
    return `- ${o.name} (creado ${o.createdAt.slice(0, 10)})${o.cancelledAt ? ' CANCELADO' : ''}: pago ${o.displayFinancialStatus ?? 'desconocido'}, ` +
      `preparación ${o.displayFulfillmentStatus}${delivery ? `, entrega ${delivery}` : ''}, ` +
      (tracking.length ? `guía ${tracking.join(' / ')}` : 'aún sin número de guía')
  }).join('\n')
}

// -------------------------------------------------------------- recurrente

/** Recurrente hosted checkout for the exact order total (GTQ cents). */
export async function createRecurrenteCheckout(secretKey: string, args: { title: string; total: number; currency: string; orderId: string }) {
  const res = await fetch('https://app.recurrente.com/api/checkouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SECRET-KEY': secretKey },
    body: JSON.stringify({
      items: [{ name: args.title, currency: args.currency, amount_in_cents: Math.round(args.total * 100), quantity: 1 }],
      metadata: { shopify_order_id: args.orderId },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => null)) as { checkout_url?: string; message?: string } | null
  if (!res.ok || !json?.checkout_url) throw new ShopifyError(`Recurrente: ${json?.message ?? `HTTP ${res.status}`}`, 502)
  return json.checkout_url
}

// ------------------------------------------------- Recurrente paid → order

/** Svix signature check (Recurrente webhooks): base64 HMAC-SHA256 of
 *  `${id}.${timestamp}.${body}` keyed with the base64 part of `whsec_…`;
 *  the header may carry several space-separated `v1,<sig>` values.
 *  Timestamps more than 5 minutes off are rejected (replay). */
export function verifySvixSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64'))
  return signature.split(' ').some((part) => {
    const sig = Buffer.from(part.replace(/^v1,/, ''))
    return sig.length === expected.length && timingSafeEqual(sig, expected)
  })
}

export interface RecurrenteCheckout {
  status: 'unpaid' | 'paid' | 'payment_in_progress' | 'expired'
  total_in_cents: number
  currency: string
  metadata: Record<string, unknown> | null
}

/** Read a checkout back from Recurrente — the webhook body is never trusted for the payment state. */
export async function getRecurrenteCheckout(secretKey: string, checkoutId: string): Promise<RecurrenteCheckout> {
  const res = await fetch(`https://app.recurrente.com/api/checkouts/${encodeURIComponent(checkoutId)}`, {
    headers: { 'X-SECRET-KEY': secretKey },
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => null)) as (RecurrenteCheckout & { message?: string }) | null
  if (!res.ok || !json?.status) throw new ShopifyError(`Recurrente: ${json?.message ?? `HTTP ${res.status}`}`, 502)
  return json
}

/** Complete a draft as a PAID order (it then reaches Dropify/Dropi). Returns
 *  null when the draft is already completed (webhook retries, the legacy and
 *  unified events both arriving) or its total doesn't match `expectedTotal`. */
export async function completePaidDraftOrder(
  cfg: Pick<ShopifyConfig, 'shop' | 'token' | 'refreshToken'>,
  draftId: string,
  expectedTotal: number,
): Promise<{ id: string; name: string } | null> {
  const { draftOrder } = await shopifyGraphql<{
    draftOrder: { status: string; totalPriceSet: { shopMoney: { amount: string } } } | null
  }>(cfg, `query($id: ID!) { draftOrder(id: $id) { status totalPriceSet { shopMoney { amount } } } }`, { id: draftId })
  if (!draftOrder || draftOrder.status === 'COMPLETED') return null
  if (Math.abs(Number(draftOrder.totalPriceSet.shopMoney.amount) - expectedTotal) > 0.009) {
    console.warn(`[recurrente] ${draftId} total ${draftOrder.totalPriceSet.shopMoney.amount} != paid ${expectedTotal}, not completed`)
    return null
  }
  // No paymentPending → Shopify records the order as paid.
  const data = await shopifyGraphql<{
    draftOrderComplete: { draftOrder: { order: { id: string; name: string } | null } | null; userErrors: { message: string }[] }
  }>(cfg, `mutation($id: ID!) { draftOrderComplete(id: $id, sourceName: "${ORDER_TAG}") {
      draftOrder { order { id name } } userErrors { message } } }`, { id: draftId })
  const order = data.draftOrderComplete.draftOrder?.order
  if (!order) throw new ShopifyError(data.draftOrderComplete.userErrors.map((e) => e.message).join('; ') || 'draftOrderComplete failed')
  return order
}
