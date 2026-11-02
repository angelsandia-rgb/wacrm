// ============================================================
// Download an inbound customer WhatsApp media file server-side, for the
// AI auto-reply path (photos → vision, voice notes → transcription).
// Uses the account's own WhatsApp credentials for the number the
// conversation is pinned to — the /api/whatsapp/media proxy is
// session-gated and unreachable from a background dispatch.
//
// Returns `null` on anything it can't fetch (not a proxy URL, no config,
// provider error): the callers degrade, never fail the reply.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { downloadZernioWhatsAppMedia } from '@/lib/zernio/api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveWhatsAppConfig } from '@/lib/whatsapp/resolve-config'

export interface DownloadedMedia {
  bytes: Buffer
  /** Content-Type as reported by the provider, if any. */
  contentType: string | null
}

export type InboundMediaDownloader = (mediaUrl: string) => Promise<DownloadedMedia | null>

/** `/api/whatsapp/media/<id>` → `<id>`, or null if it isn't that shape. */
function mediaIdFromProxyUrl(url: string): string | null {
  const m = url.match(/^\/api\/whatsapp\/media\/([^/?#]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

/** Instagram / Messenger attachments are stored as Meta CDN URLs
 *  (lookaside.fbsbx.com, *.fbcdn.net, *.cdninstagram.com) that need no
 *  token. Only these hosts are fetched — never an arbitrary URL (SSRF). */
export function isMetaCdnUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  return (
    h === 'lookaside.fbsbx.com' ||
    h.endsWith('.fbcdn.net') ||
    h.endsWith('.cdninstagram.com')
  )
}

/** Hard cap on what we buffer from the CDN; callers apply their own,
 *  smaller per-type limits on top. */
const MAX_CDN_BYTES = 25 * 1024 * 1024

async function downloadMetaCdn(url: string): Promise<DownloadedMedia | null> {
  // lookaside redirects to scontent.*.fbcdn.net — follow by hand so every
  // hop is checked against the allowlist before it is requested.
  let res: Response | null = null
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!next) break
    url = new URL(next, url).toString()
    if (!isMetaCdnUrl(url)) return null
    res = null
  }
  if (!res || !res.ok) return null
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_CDN_BYTES) return null
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.byteLength > MAX_CDN_BYTES) return null
  return { bytes, contentType: res.headers.get('content-type') }
}

/**
 * Loads the conversation's `whatsapp_config` once (lazily, cached in the
 * closure) and downloads each requested media through the same Meta /
 * Zernio paths the media proxy uses.
 */
export function makeInboundMediaDownloader(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): InboundMediaDownloader {
  let configPromise: Promise<Record<string, unknown> | null> | null = null
  const loadConfig = () => {
    if (!configPromise) {
      configPromise = (async () => {
        // The media id belongs to the number the conversation is pinned
        // to — an account can have several connections, so "the
        // account's config" is ambiguous (and `maybeSingle()` on it
        // errors once a second number is connected).
        const { data: conv } = await db
          .from('conversations')
          .select('whatsapp_config_id')
          .eq('id', conversationId)
          .eq('account_id', accountId)
          .maybeSingle()
        const config = await resolveWhatsAppConfig(
          db,
          accountId,
          (conv as { whatsapp_config_id?: string | null } | null)?.whatsapp_config_id ?? null,
        )
        return (config as Record<string, unknown> | null) ?? null
      })()
    }
    return configPromise
  }

  return async (mediaUrl) => {
    if (isMetaCdnUrl(mediaUrl)) return downloadMetaCdn(mediaUrl)

    const mediaId = mediaUrl.startsWith('/api/whatsapp/media/')
      ? mediaIdFromProxyUrl(mediaUrl)
      : null
    if (!mediaId) return null

    const config = await loadConfig()
    if (!config) return null

    if (config.provider === 'zernio') {
      const res = await downloadZernioWhatsAppMedia({
        apiKey: decrypt(config.zernio_api_key as string),
        accountId: config.zernio_account_id as string,
        mediaId,
      })
      return { bytes: Buffer.from(res.buffer), contentType: res.contentType ?? null }
    }

    const accessToken = decrypt(config.access_token as string)
    const info = await getMediaUrl({ mediaId, accessToken })
    const res = await downloadMedia({ downloadUrl: info.url, accessToken })
    return { bytes: res.buffer, contentType: res.contentType || info.mimeType || null }
  }
}
