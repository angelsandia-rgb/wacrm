import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { widgetScript } from '@/lib/widget/script'

// ============================================================
// GET /api/public/widget/[accountId]  — public, no auth.
//
// Embeddable website chat widget (respond.io "growth widget" parity):
// a floating WhatsApp button that opens a chat with the account's
// default number. The business pastes
//   <script src="https://chatsandia.com/api/public/widget/<id>" data-text="Hola" async></script>
// on its site. Only the already-public WhatsApp number is exposed.
// ============================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const js = (body: string) =>
  new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })

export async function GET(_request: Request, context: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await context.params
  if (!UUID.test(accountId)) return js('/* sandia widget: invalid account */')

  const { data } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('public_phone_number')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle()
  const number = data?.public_phone_number ? sanitizePhoneForMeta(data.public_phone_number) : ''
  if (!number) return js('/* sandia widget: no public WhatsApp number configured */')

  return js(widgetScript(number))
}
