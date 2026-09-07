import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'

export class SendRestaurantMenuError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

interface MenuRow {
  restaurant_menu_url: string | null
}

/**
 * Sends the account's restaurant menu PDF (`accounts.restaurant_menu_url`,
 * migration 114) to `conversationId` — the shared core behind both the
 * human-triggered `POST /api/products/send-restaurant-menu` route and the
 * AI's autonomous `send_restaurant_menu` action (`src/lib/ai/auto-reply.ts`).
 *
 * `sendMessageToConversation` is channel-agnostic, so this already works
 * over WhatsApp, Instagram and Facebook with no per-channel branching.
 * Unlike the catalog, there is only one delivery shape here: the owner's
 * own already-online menu file, sent as a document. Throws
 * `SendRestaurantMenuError` when no menu URL is configured.
 */
export async function sendRestaurantMenuToConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<void> {
  const { data: account, error } = await db
    .from('accounts')
    .select('restaurant_menu_url')
    .eq('id', accountId)
    .maybeSingle<MenuRow>()
  if (error) throw new SendRestaurantMenuError(error.message, 500)

  const url = account?.restaurant_menu_url?.trim()
  if (!url) {
    throw new SendRestaurantMenuError(
      'No restaurant menu PDF configured yet — add one in Products → Catálogo.',
    )
  }

  try {
    await sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: 'document',
      mediaUrl: url,
      filename: 'Menu.pdf',
    })
  } catch (err) {
    if (err instanceof SendMessageError) {
      throw new SendRestaurantMenuError(err.message, err.status)
    }
    throw err
  }
}
