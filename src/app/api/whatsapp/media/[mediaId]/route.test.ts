import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  configQueried: false,
  downloadCalled: false,
  ownedMessage: null as Record<string, unknown> | null,
  resolvedWith: [] as unknown[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-a' } }, error: null }),
    },
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { account_id: 'account-a' }, error: null }),
            }),
          }),
        }
      }

      if (table === 'messages') {
        return {
          select: () => ({
            eq: () => ({
              eq: (column: string, accountId: string) => {
                expect(column).toBe('conversations.account_id')
                expect(accountId).toBe('account-a')
                return {
                  limit: () => ({
                    maybeSingle: async () => ({ data: h.ownedMessage, error: null }),
                  }),
                }
              },
            }),
          }),
        }
      }

      if (table === 'whatsapp_config') {
        h.configQueried = true
        throw new Error('Config must not be queried for unowned media')
      }

      throw new Error(`Unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@/lib/whatsapp/resolve-config', () => ({
  resolveWhatsAppConfig: vi.fn(async (_db: unknown, accountId: string, configId: string | null) => {
    h.configQueried = true
    h.resolvedWith = [accountId, configId]
    return { id: configId, provider: 'meta', access_token: `enc-${configId}` }
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(async () => {
    h.downloadCalled = true
    return { url: 'https://meta.test/blob' }
  }),
  downloadMedia: vi.fn(async () => ({
    buffer: new TextEncoder().encode('JPEG').buffer,
    contentType: 'image/jpeg',
  })),
}))
vi.mock('@/lib/zernio/api', () => ({
  downloadZernioWhatsAppMedia: vi.fn(() => {
    h.downloadCalled = true
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn((v: string) => v) }))

import { GET } from './route'

describe('WhatsApp media tenant isolation', () => {
  it('returns 404 before reading provider credentials for unowned media', async () => {
    h.configQueried = false
    h.downloadCalled = false
    h.ownedMessage = null

    const response = await GET(new Request('https://crm.test/api/whatsapp/media/media-foreign'), {
      params: Promise.resolve({ mediaId: 'media-foreign' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Media not found' })
    expect(h.configQueried).toBe(false)
    expect(h.downloadCalled).toBe(false)
  })

  it('uses the credentials of the number the conversation is pinned to, privately cached', async () => {
    h.configQueried = false
    h.downloadCalled = false
    h.ownedMessage = { id: 'msg-1', conversations: { account_id: 'account-a', whatsapp_config_id: 'cfg-b' } }

    const response = await GET(new Request('https://crm.test/api/whatsapp/media/media-own'), {
      params: Promise.resolve({ mediaId: 'media-own' }),
    })

    expect(response.status).toBe(200)
    expect(h.resolvedWith).toEqual(['account-a', 'cfg-b'])
    expect(h.downloadCalled).toBe(true)
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=86400')
  })
})
