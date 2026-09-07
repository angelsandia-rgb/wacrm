import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/send-message')>()
  return { ...actual, sendMessageToConversation: vi.fn() }
})

import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'
import {
  sendRestaurantMenuToConversation,
  SendRestaurantMenuError,
} from './send-restaurant-menu'

const h = vi.mocked({ sendMessageToConversation })

function makeDb(restaurantMenuUrl: string | null) {
  const db = {
    from: (table: string) => {
      if (table !== 'accounts') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { restaurant_menu_url: restaurantMenuUrl }, error: null }),
          }),
        }),
      }
    },
  }
  return db as unknown as SupabaseClient
}

beforeEach(() => {
  h.sendMessageToConversation.mockReset()
  h.sendMessageToConversation.mockResolvedValue({ messageId: 'msg-1', whatsappMessageId: 'wamid-1' })
})

describe('sendRestaurantMenuToConversation', () => {
  it('sends the configured menu PDF as a document', async () => {
    const db = makeDb('https://storage.example.com/menu.pdf')
    await sendRestaurantMenuToConversation(db, 'acct-1', 'conv-1')

    expect(h.sendMessageToConversation).toHaveBeenCalledWith(db, 'acct-1', {
      conversationId: 'conv-1',
      messageType: 'document',
      mediaUrl: 'https://storage.example.com/menu.pdf',
      filename: 'Menu.pdf',
    })
  })

  it('trims surrounding whitespace from the stored URL', async () => {
    const db = makeDb('  https://storage.example.com/menu.pdf  ')
    await sendRestaurantMenuToConversation(db, 'acct-1', 'conv-1')
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      db,
      'acct-1',
      expect.objectContaining({ mediaUrl: 'https://storage.example.com/menu.pdf' }),
    )
  })

  it('throws without sending when no menu URL is configured', async () => {
    for (const value of [null, '', '   ']) {
      h.sendMessageToConversation.mockClear()
      await expect(
        sendRestaurantMenuToConversation(makeDb(value), 'acct-1', 'conv-1'),
      ).rejects.toBeInstanceOf(SendRestaurantMenuError)
      expect(h.sendMessageToConversation).not.toHaveBeenCalled()
    }
  })

  it('wraps a SendMessageError from the send core into a SendRestaurantMenuError', async () => {
    h.sendMessageToConversation.mockRejectedValue(
      new SendMessageError('provider_error', 'channel down', 502),
    )
    const db = makeDb('https://storage.example.com/menu.pdf')
    await expect(
      sendRestaurantMenuToConversation(db, 'acct-1', 'conv-1'),
    ).rejects.toMatchObject({ status: 502, message: 'channel down' })
  })
})
