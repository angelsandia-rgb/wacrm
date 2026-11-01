import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { mentionLabel, resolveMentions } from '@/lib/inbox/mentions'

/**
 * POST /api/conversations/[id]/comments
 *
 * Internal team comment on a conversation (migration 173). Never sent
 * to the customer. Every `@teammate` in the body gets a 'mention'
 * notification, which the push fanout trigger delivers.
 *
 * Body: { body: string }
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await context.params
    const payload = await request.json().catch(() => null)
    const body = typeof payload?.body === 'string' ? payload.body.trim() : ''
    if (!body || body.length > 4000) {
      return NextResponse.json({ error: 'body must be 1–4000 characters' }, { status: 400 })
    }

    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, contact_id, contact:contacts(name, phone, instagram_username)')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const { data: members } = await supabase
      .from('profiles')
      .select('user_id, full_name, email')
      .eq('account_id', accountId)
    const mentions = resolveMentions(body, members ?? []).filter((uid) => uid !== userId)

    const { data: comment, error } = await supabase
      .from('conversation_comments')
      .insert({ account_id: accountId, conversation_id: id, author_id: userId, body, mentions })
      .select('*')
      .single()
    if (error) {
      console.error('[comments] insert failed:', error)
      return NextResponse.json({ error: 'Failed to save comment' }, { status: 500 })
    }

    if (mentions.length > 0) {
      const author = (members ?? []).find((m) => m.user_id === userId)
      const contact = Array.isArray(conversation.contact) ? conversation.contact[0] : conversation.contact
      const who = contact?.name || contact?.instagram_username || contact?.phone || 'un cliente'
      const { error: notifyErr } = await supabaseAdmin()
        .from('notifications')
        .insert(
          mentions.map((uid) => ({
            account_id: accountId,
            user_id: uid,
            type: 'mention',
            conversation_id: id,
            contact_id: conversation.contact_id,
            actor_user_id: userId,
            title: `${author ? mentionLabel(author) : 'Un compañero'} te mencionó · ${who}`,
            body: body.slice(0, 500),
          })),
        )
      if (notifyErr) console.error('[comments] mention notifications failed:', notifyErr)
    }

    return NextResponse.json({ comment }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
