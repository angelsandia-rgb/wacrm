import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  audioFileExtension,
  makeVoiceNoteTranscriber,
  transcribeAudio,
  transcriptionKey,
} from './voice-notes'
import { buildConversationContext } from './context'

const ok = (text: string) => new Response(text, { status: 200 })

describe('transcriptionKey', () => {
  it('uses the provider key on OpenAI, else the OpenAI embeddings key', () => {
    expect(transcriptionKey({ provider: 'openai', apiKey: 'sk-main', embeddingsApiKey: 'sk-emb' })).toBe('sk-main')
    expect(transcriptionKey({ provider: 'anthropic', apiKey: 'ant', embeddingsApiKey: 'sk-emb' })).toBe('sk-emb')
    expect(transcriptionKey({ provider: 'anthropic', apiKey: 'ant', embeddingsApiKey: null })).toBeNull()
  })
})

describe('audioFileExtension', () => {
  it('maps WhatsApp voice-note types, rejects the rest', () => {
    expect(audioFileExtension('audio/ogg; codecs=opus')).toBe('ogg')
    expect(audioFileExtension('audio/mpeg')).toBe('mp3')
    expect(audioFileExtension('image/jpeg')).toBeNull()
    expect(audioFileExtension(null)).toBeNull()
  })
})

describe('transcribeAudio', () => {
  it('falls back to whisper-1 when the newer model is not available', async () => {
    const models: string[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const model = (init!.body as FormData).get('model') as string
      models.push(model)
      return model === 'whisper-1' ? ok(' hola, quiero una habitación \n') : new Response('no access', { status: 404 })
    }) as unknown as typeof fetch
    const text = await transcribeAudio({ apiKey: 'k', bytes: Buffer.from('ogg'), contentType: 'audio/ogg', fetchImpl })
    expect(text).toBe('hola, quiero una habitación')
    expect(models).toEqual(['gpt-4o-mini-transcribe', 'whisper-1'])
  })

  it('does not retry on an auth or server error', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch
    await expect(
      transcribeAudio({ apiKey: 'k', bytes: Buffer.from('x'), contentType: 'audio/ogg', fetchImpl }),
    ).rejects.toThrow('401')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

function updateSpyDb() {
  const updates: { id: string; transcript: string }[] = []
  const db = {
    from: () => ({
      update: (row: { transcript: string }) => ({
        eq: async (_c: string, id: string) => {
          updates.push({ id, transcript: row.transcript })
          return { error: null }
        },
      }),
    }),
  } as unknown as SupabaseClient
  return { db, updates }
}

describe('makeVoiceNoteTranscriber', () => {
  it('reuses a cached transcript without downloading', async () => {
    const download = vi.fn()
    const t = makeVoiceNoteTranscriber({ db: updateSpyDb().db, apiKey: 'k', download })
    expect(await t({ id: 'm1', media_url: '/api/whatsapp/media/a', transcript: 'ya transcrito' })).toBe('ya transcrito')
    expect(download).not.toHaveBeenCalled()
  })

  it('transcribes once and stores the result on the message', async () => {
    const { db, updates } = updateSpyDb()
    const t = makeVoiceNoteTranscriber({
      db,
      apiKey: 'k',
      download: async () => ({ bytes: Buffer.from('audio'), contentType: 'audio/ogg' }),
      fetchImpl: (async () => ok('precio de la suite')) as unknown as typeof fetch,
    })
    expect(await t({ id: 'm1', media_url: '/api/whatsapp/media/a', transcript: null })).toBe('precio de la suite')
    expect(updates).toEqual([{ id: 'm1', transcript: 'precio de la suite' }])
  })

  it('degrades to null on a failed download or API error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fail = makeVoiceNoteTranscriber({
      db: updateSpyDb().db,
      apiKey: 'k',
      download: async () => {
        throw new Error('zernio down')
      },
    })
    expect(await fail({ id: 'm1', media_url: '/api/whatsapp/media/a', transcript: null })).toBeNull()
  })
})

describe('buildConversationContext with voice notes', () => {
  function contextDb(rows: Record<string, unknown>[]) {
    let selected = ''
    const chain: Record<string, unknown> = {
      select: (cols: string) => {
        selected = cols
        return chain
      },
      eq: () => chain,
      in: () => chain,
      gt: () => chain,
      order: () => chain,
      limit: async () => ({ data: [...rows].reverse(), error: null }),
    }
    return { db: { from: () => chain } as unknown as SupabaseClient, selected: () => selected }
  }

  const audio = (id: string, transcript: string | null = null) => ({
    id,
    transcript,
    sender_type: 'customer',
    content_type: 'audio',
    content_text: null,
    media_url: `/api/whatsapp/media/${id}`,
  })

  it('adds transcribed notes as customer turns, capped per reply (cached ones free)', async () => {
    const rows = [audio('a1'), audio('a2'), audio('a3', 'cacheado'), audio('a4'), audio('a5'), audio('a6')]
    const { db } = contextDb(rows)
    const transcriber = vi.fn(async (r: { id: string }) => `texto ${r.id}`)
    const out = await buildConversationContext(db, 'c1', 50, null, null, transcriber)
    // Newest-first: a6, a5, a4 transcribed (cap 3); a3 cached; a1, a2 skipped.
    expect(transcriber).toHaveBeenCalledTimes(3)
    expect(out.map((m) => m.content)).toEqual([
      '(Nota de voz del cliente, transcrita): cacheado',
      '(Nota de voz del cliente, transcrita): texto a4',
      '(Nota de voz del cliente, transcrita): texto a5',
      '(Nota de voz del cliente, transcrita): texto a6',
    ])
  })

  it('without a transcriber never selects the transcript column', async () => {
    const { db, selected } = contextDb([])
    await buildConversationContext(db, 'c1', 50, null, null, null)
    expect(selected()).not.toContain('transcript')
  })
})
