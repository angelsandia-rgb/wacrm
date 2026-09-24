// ============================================================
// Inbound customer photos → provider image blocks, for the AI
// auto-reply path. Downloads the media server-side with the account's
// own WhatsApp credentials (inbound-media.ts), then hands back a base64
// `ChatImage` for `buildConversationContext`.
//
// Everything here degrades to `null` on any problem (unsupported
// format, too large, download failure, no config) — a photo the AI
// can't see must never break the reply, same "degrade, never fail"
// contract as the rest of auto-reply.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { makeInboundMediaDownloader } from './inbound-media'
import type { AiProvider, ChatImage } from './types'

/** Formats every current Claude model and the GPT-4o family accept. */
const VISION_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** Provider ceilings: Anthropic 5 MB/image, OpenAI ~20 MB but base64
 *  inflation + token cost make anything this big a bad idea anyway. */
export const MAX_INBOUND_IMAGE_BYTES = 4 * 1024 * 1024

/** How many of the most recent customer photos the AI is shown for one
 *  reply — keeps token spend bounded when someone dumps an album. */
export const MAX_INBOUND_IMAGES_PER_REPLY = 4

/** A media URL/type is a photo we can actually send to the model. */
export function isSupportedInboundImage(
  mimeType: string | null | undefined,
  byteLength: number,
): boolean {
  if (!mimeType) return false
  const base = mimeType.split(';')[0].trim().toLowerCase()
  return VISION_MIME.has(base) && byteLength > 0 && byteLength <= MAX_INBOUND_IMAGE_BYTES
}

/** Every current Claude model is vision-capable. For OpenAI only the
 *  4o / 4.1 / 5 / o-series lines are — older `gpt-3.5*` / `gpt-4-0613`
 *  reject image parts, so we just don't send them. */
export function providerSupportsVision(provider: AiProvider, model: string): boolean {
  if (provider === 'anthropic') return true
  const m = model.toLowerCase()
  if (m.includes('gpt-3.5') || m.includes('instruct')) return false
  return (
    m.includes('4o') ||
    m.includes('gpt-4.1') ||
    m.includes('gpt-5') ||
    m.includes('gpt-4-turbo') ||
    /\bo[1345]\b/.test(m) ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4')
  )
}

/**
 * A resolver `buildConversationContext` can call for each `image`
 * message it finds on a customer turn: downloads the photo (see
 * inbound-media.ts) and base64-encodes it. Returns `null` for anything
 * it can't or shouldn't send.
 */
export function makeInboundImageResolver(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): (mediaUrl: string, mediaType: string | null) => Promise<ChatImage | null> {
  const download = makeInboundMediaDownloader(db, accountId, conversationId)

  return async (mediaUrl, mediaType) => {
    try {
      // Cheap early-out on the MIME the webhook already recorded, before
      // spending a download.
      if (mediaType && !isSupportedInboundImage(mediaType, MAX_INBOUND_IMAGE_BYTES)) {
        return null
      }
      const media = await download(mediaUrl)
      if (!media) return null

      const mime = (media.contentType || mediaType || '').split(';')[0].trim().toLowerCase()
      if (!isSupportedInboundImage(mime, media.bytes.byteLength)) return null

      return { mimeType: mime, dataBase64: media.bytes.toString('base64') }
    } catch (err) {
      console.warn('[ai inbound-image] could not attach a customer photo:', err)
      return null
    }
  }
}

export type InboundImageResolver = ReturnType<typeof makeInboundImageResolver>
