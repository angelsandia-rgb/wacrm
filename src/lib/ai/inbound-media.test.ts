import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMetaCdnUrl, makeInboundMediaDownloader } from './inbound-media'

describe('isMetaCdnUrl', () => {
  it('accepts Meta CDN hosts over https only', () => {
    expect(isMetaCdnUrl('https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1')).toBe(true)
    expect(isMetaCdnUrl('https://scontent.xx.fbcdn.net/v/t1/a.jpg')).toBe(true)
    expect(isMetaCdnUrl('https://scontent.cdninstagram.com/a.jpg')).toBe(true)
    expect(isMetaCdnUrl('http://lookaside.fbsbx.com/x')).toBe(false)
    expect(isMetaCdnUrl('https://evil.com/?fbcdn.net')).toBe(false)
    expect(isMetaCdnUrl('https://fbcdn.net.evil.com/a')).toBe(false)
    expect(isMetaCdnUrl('/api/whatsapp/media/abc')).toBe(false)
  })
})

describe('makeInboundMediaDownloader (Meta CDN)', () => {
  afterEach(() => vi.unstubAllGlobals())
  const db = {} as never

  it('follows an allowlisted redirect and returns the bytes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://scontent.xx.fbcdn.net/a.jpg' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)
    const dl = makeInboundMediaDownloader(db, 'acc', 'conv')
    const out = await dl('https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1')
    expect(out?.bytes.byteLength).toBe(3)
    expect(out?.contentType).toBe('image/jpeg')
  })

  it('refuses a redirect off the allowlist without requesting it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
    vi.stubGlobal('fetch', fetchMock)
    const dl = makeInboundMediaDownloader(db, 'acc', 'conv')
    expect(await dl('https://lookaside.fbsbx.com/x')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
