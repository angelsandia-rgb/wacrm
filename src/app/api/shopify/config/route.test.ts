import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  graphql: vi.fn(),
  existing: null as Record<string, unknown> | null,
  saved: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: vi.fn(),
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth' }, { status: 403 })),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') }))
vi.mock('@/lib/shopify/api', () => ({
  SHOP_DOMAIN_RE: /^[a-z0-9-]+\.myshopify\.com$/,
  ShopifyError: class extends Error {},
  fetchClientCredentialsToken: vi.fn(async () => ({ token: 'tok', expiresAt: new Date() })),
  shopifyGraphql: mocks.graphql,
}))

import { PUT } from './route'

function supabase() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: mocks.existing }),
    insert: async (row: Record<string, unknown>) => { mocks.saved.push(row); return { error: null } },
    update: (row: Record<string, unknown>) => { mocks.saved.push(row); return { eq: async () => ({ error: null }) } },
  }
  return { from: () => chain }
}

const put = (body: unknown) => PUT(new Request('http://x/api/shopify/config', { method: 'PUT', body: JSON.stringify(body) }))

beforeEach(() => {
  mocks.saved = []
  mocks.existing = null
  mocks.requireRole.mockResolvedValue({ supabase: supabase(), accountId: 'a1', userId: 'u1' })
  mocks.graphql.mockResolvedValue({ shop: { name: 'Casa Ceiba', myshopifyDomain: 'x0rkkg-b4.myshopify.com' } })
})

describe('PUT /api/shopify/config', () => {
  it('saves the permanent myshopify domain, not the alias typed (webhooks are keyed by it)', async () => {
    const res = await put({ shop_domain: 'casaceibagt.myshopify.com', client_id: 'cid', client_secret: 'sec' })
    expect(res.status).toBe(200)
    expect(mocks.saved[0].shop_domain).toBe('x0rkkg-b4.myshopify.com')
  })

  it('keeps the stored domain when saving without new credentials', async () => {
    mocks.existing = { id: '1', client_id: null, client_secret: null, shop_domain: 'x0rkkg-b4.myshopify.com' }
    await put({ shop_domain: 'casaceibagt.myshopify.com', orders_live: true })
    expect(mocks.graphql).not.toHaveBeenCalled()
    expect(mocks.saved[0].shop_domain).toBe('x0rkkg-b4.myshopify.com')
  })
})
