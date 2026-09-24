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
