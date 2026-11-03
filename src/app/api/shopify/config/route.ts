import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { fetchClientCredentialsToken, SHOP_DOMAIN_RE, ShopifyError, shopifyGraphql } from '@/lib/shopify/api'

/** GET — connection status. Never returns the token or webhook secret. */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data } = await supabase
      .from('shopify_config')
      .select('shop_domain, webhook_secret, orders_live, confirmation_template_name, confirmation_template_language, last_sync_at, recurrente_secret_key, recurrente_webhook_secret, client_id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!data) return NextResponse.json({ connected: false })
    return NextResponse.json({
      connected: true,
      shop_domain: data.shop_domain,
      auth_mode: data.client_id ? 'client_credentials' : 'token',
      client_id: data.client_id,
      has_webhook_secret: Boolean(data.webhook_secret),
      has_recurrente_key: Boolean(data.recurrente_secret_key),
      has_recurrente_webhook_secret: Boolean(data.recurrente_webhook_secret),
      orders_live: data.orders_live,
      confirmation_template_name: data.confirmation_template_name,
      confirmation_template_language: data.confirmation_template_language,
      last_sync_at: data.last_sync_at,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PUT — connect or update. Body: { shop_domain, access_token? | (client_id +
 * client_secret?), webhook_secret?,
 * orders_live?, confirmation_template_name?, confirmation_template_language?,
 * recurrente_secret_key?, recurrente_webhook_secret? }. Secrets omitted = keep the stored ones.
 * access_token is required on first connect; omitted = keep the stored one.
 * A Dev Dashboard app sends client_id + client_secret instead of a token:
 * they are traded for a 24 h token (cached, refreshed in loadShopifyConfig).
 * New credentials are verified against the store before they are saved.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

    const shop = String(body.shop_domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!SHOP_DOMAIN_RE.test(shop)) {
      return NextResponse.json({ error: 'El dominio debe ser tu-tienda.myshopify.com' }, { status: 400 })
    }
    const token = typeof body.access_token === 'string' ? body.access_token.trim() : ''
    const secret = typeof body.webhook_secret === 'string' ? body.webhook_secret.trim() : ''
    const recurrenteKey = typeof body.recurrente_secret_key === 'string' ? body.recurrente_secret_key.trim() : ''
    const recurrenteWebhookSecret = typeof body.recurrente_webhook_secret === 'string' ? body.recurrente_webhook_secret.trim() : ''
    if (recurrenteWebhookSecret && !recurrenteWebhookSecret.startsWith('whsec_')) {
      return NextResponse.json({ error: 'La clave del webhook de Recurrente empieza con whsec_' }, { status: 400 })
    }
    const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
    let clientSecret = typeof body.client_secret === 'string' ? body.client_secret.trim() : ''

    const { data: existing } = await supabase
      .from('shopify_config').select('id, client_id, client_secret, shop_domain').eq('account_id', accountId).maybeSingle()
    // Same app, secret omitted = keep the stored one (re-verified only if the shop changed).
    const reuseSecret = Boolean(!clientSecret && clientId && existing?.client_secret && existing.client_id === clientId)
    if (reuseSecret && existing?.shop_domain !== shop) clientSecret = decrypt(existing!.client_secret as string)
    if (clientId && !clientSecret && !reuseSecret) return NextResponse.json({ error: 'Falta el Client secret' }, { status: 400 })
    if (!existing && !token && !clientId) {
      return NextResponse.json({ error: 'Falta el token de acceso o el Client ID y Client secret' }, { status: 400 })
    }

    let shopName: string | null = null
    let grant: { token: string; expiresAt: Date } | null = null
    if (token || clientSecret) {
      try {
        if (!token) grant = await fetchClientCredentialsToken(shop, clientId, clientSecret)
        const data = await shopifyGraphql<{ shop: { name: string } }>({ shop, token: token || grant!.token }, '{ shop { name } }')
        shopName = data.shop.name
      } catch (err) {
        const message = err instanceof ShopifyError ? err.message : 'No se pudo conectar con Shopify'
        return NextResponse.json({ error: message }, { status: 400 })
      }
    }

    const row: Record<string, unknown> = {
      account_id: accountId,
      user_id: userId,
      shop_domain: shop,
      orders_live: body.orders_live === true,
      confirmation_template_name:
        typeof body.confirmation_template_name === 'string' ? body.confirmation_template_name.trim() || null : null,
      confirmation_template_language:
        typeof body.confirmation_template_language === 'string' && body.confirmation_template_language.trim()
          ? body.confirmation_template_language.trim()
          : 'es',
    }
    if (token) {
      // A static token replaces any Dev Dashboard app credentials.
      Object.assign(row, { access_token: encrypt(token), client_id: null, client_secret: null, access_token_expires_at: null })
    } else if (grant) {
      Object.assign(row, {
        access_token: encrypt(grant.token),
        access_token_expires_at: grant.expiresAt.toISOString(),
        client_id: clientId,
        client_secret: encrypt(clientSecret),
      })
    }
    if (secret) row.webhook_secret = encrypt(secret)
    if (recurrenteKey) row.recurrente_secret_key = encrypt(recurrenteKey)
    if (recurrenteWebhookSecret) row.recurrente_webhook_secret = encrypt(recurrenteWebhookSecret)

    const { error } = existing
      ? await supabase.from('shopify_config').update(row).eq('account_id', accountId)
      : await supabase.from('shopify_config').insert(row)
    if (error) {
      console.error('[shopify/config PUT] save failed:', error.message)
      const taken = error.code === '23505'
      return NextResponse.json(
        { error: taken ? 'Esa tienda ya está conectada a otra cuenta' : 'No se pudo guardar' },
        { status: taken ? 409 : 500 },
      )
    }
    return NextResponse.json({ success: true, shop_name: shopName })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE — disconnect (drops the stored credentials; synced products stay). */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('shopify_config').delete().eq('account_id', accountId)
    if (error) return NextResponse.json({ error: 'No se pudo desconectar' }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
