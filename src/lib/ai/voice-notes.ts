// ============================================================
// Inbound voice notes → text the AI can read.
//
// Neither the Anthropic nor the OpenAI chat API takes raw audio, so a
// customer's voice note is transcribed first (OpenAI transcription API)
// and the text is stored on `messages.transcript` (migration 156): each
// note is transcribed — and paid for — once, and the inbox shows it under
// the player. Gated per account by the `ai_voice_notes` feature flag.
//
// Degrade, never fail: no OpenAI key, a download or API error, an
// oversized file — the note is simply left out of the AI's context.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import type { InboundMediaDownloader } from './inbound-media'

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
/** Cheapest current transcription model; `whisper-1` is the fallback for
 *  keys/projects without access to it. */
const TRANSCRIBE_MODELS = ['gpt-4o-mini-transcribe', 'whisper-1'] as const
/** OpenAI's upload limit is 25 MB; WhatsApp voice notes are far smaller. */
const MAX_VOICE_NOTE_BYTES = 25 * 1024 * 1024
/** Newest voice notes transcribed per reply — bounds cost and latency
 *  when a customer sends a burst of audios. */
export const MAX_VOICE_NOTES_PER_REPLY = 3
const TRANSCRIBE_TIMEOUT_MS = 30_000

/** Formats the transcription API accepts (flac, mp3, mp4, m4a, ogg, wav,
 *  webm), by MIME base type. AMR is not accepted, so it is left out. */
const AUDIO_EXTENSION: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
}

/**
 * The OpenAI key to transcribe with: the provider key when the account
 * runs on OpenAI, otherwise the (OpenAI) embeddings key if one is set.
 */
export function transcriptionKey(config: Pick<AiConfig, 'provider' | 'apiKey' | 'embeddingsApiKey'>): string | null {
  if (config.provider === 'openai' && config.apiKey) return config.apiKey
  return config.embeddingsApiKey || null
}

export function audioFileExtension(contentType: string | null | undefined): string | null {
  if (!contentType) return null
  const base = contentType.split(';')[0].trim().toLowerCase()
  return AUDIO_EXTENSION[base] ?? null
}

/** One transcription call; throws on HTTP/network failure. */
export async function transcribeAudio(args: {
  apiKey: string
  bytes: Buffer
  contentType: string
  fetchImpl?: typeof fetch
}): Promise<string> {
  const ext = audioFileExtension(args.contentType)
  if (!ext) throw new Error(`unsupported audio type: ${args.contentType}`)
  const doFetch = args.fetchImpl ?? fetch

  let lastError = ''
  for (const model of TRANSCRIBE_MODELS) {
    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(args.bytes)], { type: args.contentType.split(';')[0] }),
      `voice-note.${ext}`,
    )
    form.append('model', model)
    form.append('response_format', 'text')

    const res = await doFetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
    const body = await res.text()
    if (res.ok) return body.trim()
    lastError = `${res.status} ${body.slice(0, 200)}`
    // Only a model-access problem is worth retrying on the fallback model.
    if (res.status !== 400 && res.status !== 403 && res.status !== 404) break
  }
  throw new Error(`transcription failed: ${lastError}`)
}

export interface VoiceNoteRow {
  id: string
  media_url: string | null
  transcript: string | null
}

/**
 * Returns the transcript for a customer voice note, transcribing and
 * storing it the first time. `null` when it can't be transcribed.
 */
export type VoiceNoteTranscriber = (row: VoiceNoteRow) => Promise<string | null>

export function makeVoiceNoteTranscriber(args: {
  db: SupabaseClient
  apiKey: string
  download: InboundMediaDownloader
  fetchImpl?: typeof fetch
}): VoiceNoteTranscriber {
  return async (row) => {
    if (row.transcript?.trim()) return row.transcript.trim()
    if (!row.media_url) return null
    try {
      const media = await args.download(row.media_url)
      if (!media || media.bytes.byteLength === 0 || media.bytes.byteLength > MAX_VOICE_NOTE_BYTES) {
        return null
      }
      const contentType = media.contentType ?? 'audio/ogg'
      const text = await transcribeAudio({
        apiKey: args.apiKey,
        bytes: media.bytes,
        contentType,
        fetchImpl: args.fetchImpl,
      })
      if (!text) return null
      // Cache it: a second reply (or the inbox) reuses it for free.
      const { error } = await args.db.from('messages').update({ transcript: text }).eq('id', row.id)
      if (error) console.warn('[ai voice-notes] could not store transcript:', error.message)
      return text
    } catch (err) {
      console.warn('[ai voice-notes] could not transcribe a voice note:', err)
      return null
    }
  }
}
