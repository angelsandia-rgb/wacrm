import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { attentionBody, loadAttentionContext } from './hotel-attention'

type Row = { sender_type: string; content_type: string; content_text: string | null; created_at: string }
function fixture(rows: Row[]) {
  const filters: unknown[][] = []
  const chain = { select: () => chain, eq: (...args: unknown[]) => { filters.push(args); return chain }, neq: (...args: unknown[]) => { filters.push(args); return chain }, order: () => chain, limit: async () => ({ data: rows, error: null }) }
  return { db: { from: () => chain } as unknown as SupabaseClient, filters }
}
const row = (sender_type: string, content_text: string | null, minute: string, content_type = 'text'): Row => ({ sender_type, content_text, content_type, created_at: `2026-10-23T02:${minute}:00Z` })

describe('attention context from current conversation', () => {
  it('finds a payment before thanks and preserves the attachment as unverified evidence', async () => {
    const f = fixture([row('customer', 'Gracias', '05'), row('customer', 'Adjunto pago', '04'), row('customer', null, '03', 'image'), row('agent', 'Le comparto el medio de pago autorizado', '01')])
    const context = await loadAttentionContext(f.db, 'hotel', 'chat')
    expect(context.customerText).toBe('Archivo adjunto para revisión Adjunto pago Gracias')
    expect(attentionBody('Gestión pendiente.', null, 'Gracias', context)).toContain('comprobante de pago')
    expect(f.filters).toContainEqual(['conversations.account_id', 'hotel'])
    expect(f.filters).toContainEqual(['status', 'failed'])
  })
  it('does not let an old request or earlier customer turn leak across the staff response', async () => {
    const f = fixture([row('customer', '2 porfavor', '05'), row('agent', '¿Desea una o dos facturas?', '04'), row('customer', 'Voy a pagar', '03')])
    const context = await loadAttentionContext(f.db, 'hotel', 'chat')
    expect(context.customerText).toBe('2 porfavor')
    expect(context.staffText).toContain('facturas')
    expect(attentionBody('Gestión pendiente.', null, '2 porfavor', context)).toContain('facturación')
  })
  it('ignores automatic greetings and does not use a staff question older than 24 hours', async () => {
    const f = fixture([row('customer', 'Gracias', '05'), row('agent', 'Gracias por comunicarse con Villa San Ricardo. ¿Cómo podemos ayudarle?', '04'), row('customer', 'Adjunto pago', '03'), { ...row('agent', '¿Cómo desea la factura?', '01'), created_at: '2026-10-21T02:01:00Z' }])
    const context = await loadAttentionContext(f.db, 'hotel', 'chat')
    expect(context.customerText).toContain('Adjunto pago')
    expect(context.staffText).toBeNull()
  })
})
