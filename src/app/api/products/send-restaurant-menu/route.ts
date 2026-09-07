import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  sendRestaurantMenuToConversation,
  SendRestaurantMenuError,
} from '@/lib/products/send-restaurant-menu'

/**
 * POST /api/products/send-restaurant-menu  (agent+)
 *
 * Body: { conversation_id }. Sends the account's restaurant menu PDF
 * (`accounts.restaurant_menu_url`, migration 114) to the given
 * conversation, via the same channel-agnostic send core the catalog /
 * quote-send routes use.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  try {
    const body = await request.json().catch(() => null)
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })

    const db = supabaseAdmin()

    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    try {
      await sendRestaurantMenuToConversation(db, ctx.accountId, conversationId)
      return NextResponse.json({ ok: true })
    } catch (err) {
      if (err instanceof SendRestaurantMenuError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
