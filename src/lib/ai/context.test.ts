import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Columns that actually exist on `public.messages` (see the numbered
 *  migrations). A `.select()` naming anything outside this set makes
 *  PostgREST throw 42703 at runtime — which is exactly how AI auto-reply
 *  silently died for ~1.5 days when `media_type` was added here. */
const REAL_MESSAGES_COLUMNS = new Set([
  'ai_generated', 'binary_payload', 'content_text', 'content_type',
  'conversation_id', 'created_at', 'event', 'extension', 'id', 'inserted_at',
  'interactive_payload', 'interactive_reply_id', 'media_url', 'message_id',
  'payload', 'private', 'reply_to_message_id', 'sender_id', 'sender_type',
  'skip_broadcast', 'status', 'template_name', 'topic', 'updated_at',
])

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().eq().order().limit() → { data, error }.
 *  `select()` validates its column list against the real schema so a
 *  typo'd / non-existent column fails the test instead of prod. */
function fakeDb(
  rows: unknown[],
  filters?: { includedTypes?: string[]; selectedColumns?: string[] },
): SupabaseClient {
  const chain = {
    from: () => chain,
    select: (cols: string) => {
      const list = cols.split(',').map((c) => c.trim()).filter(Boolean)
      if (filters) filters.selectedColumns = list
      const unknown = list.filter((c) => !REAL_MESSAGES_COLUMNS.has(c))
      if (unknown.length > 0) {
        return {
          ...chain,
          limit: () =>
            Promise.resolve({
              data: null,
              error: { code: '42703', message: `column messages.${unknown[0]} does not exist` },
            }),
        }
      }
      return chain
    },
    eq: () => chain,
    in: (_column: string, values: string[]) => {
      if (filters) filters.includedTypes = values
      return chain
    },
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('only SELECTs columns that exist on the messages table', async () => {
    // Regression guard: `media_type` was added to this select and the
    // column does not exist → every call threw PostgREST 42703 and AI
    // auto-reply went silently dead for every account (2026-09-06/07).
    const filters: { selectedColumns?: string[] } = {}
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'customer', content_text: 'hi' }], filters),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'hi' }])
    expect(filters.selectedColumns, 'select() named a non-existent messages column').toBeDefined()
    for (const col of filters.selectedColumns ?? []) {
      expect(REAL_MESSAGES_COLUMNS.has(col), `messages has no column "${col}"`).toBe(true)
    }
  })

  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('includes rendered templates so the AI remembers automation sends', async () => {
    const filters: { includedTypes?: string[] } = {}
    const out = await buildConversationContext(
      fakeDb(
        [{ sender_type: 'bot', content_text: 'Hello Ana, your appointment is tomorrow.' }],
        filters,
      ),
      'conv-1',
    )

    expect(filters.includedTypes).toEqual(['text', 'template'])
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'Hello Ana, your appointment is tomorrow.',
      },
    ])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  describe('inbound customer photos (with an image resolver)', () => {
    const img = { mimeType: 'image/jpeg', dataBase64: 'AAAA' }

    it('without a resolver, image rows are excluded (unchanged behaviour)', async () => {
      const filters: { includedTypes?: string[] } = {}
      const out = await buildConversationContext(
        fakeDb(
          [
            { sender_type: 'customer', content_type: 'image', content_text: 'mira', media_url: '/api/whatsapp/media/x' },
            { sender_type: 'customer', content_type: 'text', content_text: 'hola' },
          ],
          filters,
        ),
        'conv-1',
      )
      expect(filters.includedTypes).toEqual(['text', 'template'])
      expect(out).toEqual([{ role: 'user', content: 'hola' }])
    })

    it('attaches a downloaded photo to the turn and keeps the caption as text', async () => {
      const filters: { includedTypes?: string[] } = {}
      const resolver = async () => img
      const out = await buildConversationContext(
        fakeDb(
          [{ sender_type: 'customer', content_type: 'image', content_text: 'este modelo', media_url: '/api/whatsapp/media/x' }],
          filters,
        ),
        'conv-1',
        undefined,
        resolver,
      )
      expect(filters.includedTypes).toEqual(['text', 'template', 'image'])
      expect(out).toEqual([{ role: 'user', content: 'este modelo', images: [img] }])
    })

    it('uses a placeholder when the photo had no caption', async () => {
      const out = await buildConversationContext(
        fakeDb([{ sender_type: 'customer', content_type: 'image', content_text: null, media_url: '/api/whatsapp/media/x' }]),
        'conv-1',
        undefined,
        async () => img,
      )
      expect(out).toEqual([
        { role: 'user', content: '(El cliente envió una foto.)', images: [img] },
      ])
    })

    it('drops an image row entirely when the download fails', async () => {
      const out = await buildConversationContext(
        fakeDb([
          { sender_type: 'customer', content_type: 'image', content_text: null, media_url: '/api/whatsapp/media/x' },
          { sender_type: 'customer', content_type: 'text', content_text: 'seguime ayudando' },
        ]),
        'conv-1',
        undefined,
        async () => null,
      )
      expect(out).toEqual([{ role: 'user', content: 'seguime ayudando' }])
    })

    it('never attaches a bot/agent image as a customer photo', async () => {
      const resolver = vi.fn(async () => img)
      const out = await buildConversationContext(
        fakeDb([{ sender_type: 'bot', content_type: 'image', content_text: 'aquí tienes', media_url: '/api/whatsapp/media/x' }]),
        'conv-1',
        undefined,
        resolver,
      )
      expect(resolver).not.toHaveBeenCalled()
      expect(out).toEqual([])
    })
  })
})
