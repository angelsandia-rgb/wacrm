import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/webhooks/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { createShopifyOrderFromChat } from '@/lib/shopify/chat-order'
import { listContactOrders, ShopifyError } from '@/lib/shopify/api'

/** The conversation's contact, read through the caller's own (RLS) client so
 *  another account's conversation id resolves to nothing. */
async function conversationContact(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'], accountId: string, conversationId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('conversations').select('contact_id').eq('id', conversationId).eq('account_id', accountId).maybeSingle()
  return (data?.contact_id as string | undefined) ?? null
}

/** GET ?conversation_id= — the contact's Shopify orders with their live
 *  payment / preparation / tracking state, for the inbox card.
 *  `{ connected: false }` when the account has no store. */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const conversationId = new URL(request.url).searchParams.get('conversation_id') ?? ''
    const contactId = conversationId ? await conversationContact(supabase, accountId, conversationId) : null
    if (!contactId) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    try {
      const orders = await listContactOrders(supabaseAdmin(), accountId, contactId)
      return NextResponse.json(orders ? { connected: true, orders } : { connected: false, orders: [] })
    } catch (err) {
      if (err instanceof ShopifyError) return NextResponse.json({ connected: true, orders: [], error: err.message })
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateBody {
  conversation_id?: unknown
  items?: unknown
  full_name?: unknown
  phone?: unknown
  address?: unknown
  departamento?: unknown
  payment?: unknown
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * POST — a teammate places a Shopify order from the inbox: the same path the
 * AI's `create_shopify_order` marker takes (real order → Dropify → Dropi for
 * cash on delivery; draft + Recurrente link for card, completed by the
 * Recurrente webhook once paid), so the customer gets the same WhatsApp
 * confirmation with their order number.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    let body: CreateBody
    try {
      body = (await request.json()) as CreateBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const conversationId = str(body.conversation_id)
    const items = Array.isArray(body.items)
      ? body.items
          .map((i) => ({ name: str((i as { name?: unknown }).name), qty: Math.floor(Number((i as { qty?: unknown }).qty)) }))
          .filter((i) => i.name && i.qty > 0 && i.qty <= 50)
      : []
    const payment: 'cod' | 'card' | null = body.payment === 'card' ? 'card' : body.payment === 'cod' ? 'cod' : null
    const proposal = {
      items, payment: payment ?? ('cod' as const),
      fullName: str(body.full_name), phone: str(body.phone), address: str(body.address), departamento: str(body.departamento),
    }
    if (!conversationId || !items.length || !payment || !proposal.fullName || !proposal.phone || !proposal.address || !proposal.departamento) {
      return NextResponse.json({ error: 'Faltan datos del pedido' }, { status: 400 })
    }
    const contactId = await conversationContact(supabase, accountId, conversationId)
    if (!contactId) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    let problem: string | null = null
    const result = await createShopifyOrderFromChat({
      db: supabaseAdmin(), accountId, contactId, conversationId, configOwnerUserId: userId, proposal, actor: 'agent',
      handoff: async (reason) => { problem = reason },
      sendText: async (text) => {
        await sendMessageToConversation(supabase, accountId, {
          conversationId, messageType: 'text', contentText: text, senderType: 'agent', senderUserId: userId,
        })
      },
    })
    if (!result) return NextResponse.json({ error: problem ?? 'Shopify no está conectado' }, { status: 422 })
    return NextResponse.json({ order: result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
