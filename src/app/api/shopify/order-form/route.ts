import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { checkSharedRateLimit } from '@/lib/rate-limit'
import { normalizeGtPhone } from '@/lib/shopify/api'
import { parseOrderForm, submitOrderForm } from '@/lib/shopify/order-requests'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Public form embedded in the store's theme (public/shopify-order-form.js):
// no cookies, so any origin may post; abuse is bounded by the limits below.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: CORS })

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

/**
 * The store's own cash-on-delivery order form. Saves a REQUEST and asks the
 * customer on WhatsApp; the Shopify order (and so Dropify/Dropi) only
 * exists after their "sí" or their card payment. `?account=` like the
 * Recurrente webhook.
 */
export async function POST(request: Request) {
  const accountId = new URL(request.url).searchParams.get('account') ?? ''
  if (!UUID_RE.test(accountId)) return reply({ error: 'Tienda no válida.' }, 404)
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return reply({ error: 'Solicitud no válida.' }, 400)
  }
  // Honeypot: a field people never see. Bots fill it; pretend success.
  if (body.website) return reply({ ok: true })
  const input = parseOrderForm(body)
  if ('error' in input) return reply({ error: input.error }, 400)

  // Each request sends a WhatsApp message to the phone typed in: cap it per
  // client, per phone and per store so the form can't be used to spam.
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
  for (const [key, limit, windowMs] of [
    [`order-form:ip:${ip}`, 8, 3600_000], [`order-form:phone:${accountId}:${normalizeGtPhone(input.phone)}`, 3, 86_400_000],
    [`order-form:account:${accountId}`, 200, 86_400_000],
  ] as const) {
    if (!(await checkSharedRateLimit(key, { limit, windowMs })).success) {
      return reply({ error: 'Recibimos demasiados pedidos seguidos. Intente más tarde o escríbanos por WhatsApp.' }, 429)
    }
  }

  try {
    const result = await submitOrderForm(supabaseAdmin(), accountId, input)
    if ('error' in result) return reply({ error: result.error }, result.status)
    return reply({ ok: true })
  } catch (err) {
    console.error(`[order form] account ${accountId} failed:`, err instanceof Error ? err.message : err)
    return reply({ error: 'No pudimos registrar su pedido. Intente de nuevo o escríbanos por WhatsApp.' }, 500)
  }
}
