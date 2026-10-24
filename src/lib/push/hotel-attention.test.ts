import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { attentionBody, notifyHotelStaffInbound } from './hotel-attention'
import { notificationPushPayload } from './notification-payload'

vi.mock('@/lib/ai/known-context', () => ({ loadActiveReservationsSummary: async () => ({ current: '- Junior Suite · 5–6 dic · 7 personas · estimado Q1,400', stale: null }) }))
vi.mock('@/lib/ai/muted-contact', () => ({ contactMutesAi: async () => false }))
vi.mock('@/lib/ai/human-reply', () => ({ teammateRepliedRecently: async () => false }))

describe('hotel attention alerts', () => {
  beforeEach(() => { vi.useRealTimers() })
  it('keeps the action, dates, party and literal customer message in a readable Spanish push', () => {
    const body = attentionBody('El hotel debe verificar el pago.', '- Junior Suite · 5–6 dic · 7 personas', 'Ya envié Q1,400')
    const push = notificationPushPayload({ id: 'n', type: 'ai_handoff', title: 'Requiere atención: Pineda', body, conversation_id: 'chat' })
    expect(push.title).toBe('Requiere atención: Pineda')
    expect(push.body).toMatch(/verifique el pago/i)
    expect(push.body).toContain('5–6 dic')
    expect(push.body).toContain('7 personas')
    expect(push.body).toContain('Q1,400')
    expect(push.body!.length).toBeLessThanOrEqual(300)
    expect(push.url).toBe('/inbox?c=chat')
  })
  it('does not describe a guest-confirmed request as a hotel-approved visit', () => {
    expect(attentionBody('🤖 El huésped completó y confirmó su solicitud.')).toContain('Confirme disponibilidad y total')
  })
  it('notifies only the configured hotel recipient outside AI hours; retries share the same notification ID', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-20T16:00:00Z'))
    const writes: Record<string, unknown>[][] = []
    const rows: Record<string, unknown> = {
      accounts: { industry_vertical: 'hotel', feature_flags: ['ai_attention_hours_20_8'], timezone: 'America/Guatemala' },
      conversations: { ai_autoreply_disabled: false, contacts: { name: 'Pineda' } },
      ai_configs: { handoff_agent_id: 'ana', auto_reply_enabled: true },
      profiles: [{ user_id: 'ana' }, { user_id: 'agency' }],
    }
    const db = { from(table: string) {
      const result = { data: rows[table], error: null }
      const chain = { select: () => chain, eq: () => chain, in: () => chain, maybeSingle: async () => result,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
        upsert: async (value: Record<string, unknown>[]) => { writes.push(value); return { error: null } } }
      return chain
    } } as unknown as SupabaseClient
    const event = { conversation_id: 'chat', contact_id: 'pineda', whatsapp_message_id: 'm1', text: 'Quiero reservar' }
    await notifyHotelStaffInbound(db, 'hotel', event)
    await notifyHotelStaffInbound(db, 'hotel', event)
    expect(writes[0]).toHaveLength(1)
    expect(writes[0][0]).toMatchObject({ user_id: 'ana', conversation_id: 'chat' })
    expect(writes[0][0].id).toBe(writes[1][0].id)
    await notifyHotelStaffInbound(db, 'hotel', { ...event, whatsapp_message_id: 'm2' })
    expect(writes[2][0].id).not.toBe(writes[0][0].id)
    await notifyHotelStaffInbound(db, 'hotel', { ...event, whatsapp_message_id: 'acceptance', text: 'Sí' })
    expect(writes).toHaveLength(4)
    for (const text of ['Muchas gracias 🙏🏼🙏🏼', 'Muchísimas gracias, buenas noches', 'Muy bien Licenciada']) {
      await notifyHotelStaffInbound(db, 'hotel', { ...event, text })
    }
    expect(writes).toHaveLength(4)
    vi.setSystemTime(new Date('2026-10-21T03:00:00Z'))
    await notifyHotelStaffInbound(db, 'hotel', { ...event, whatsapp_message_id: 'm3' })
    expect(writes).toHaveLength(4)
    await notifyHotelStaffInbound(db, 'hotel', { ...event, text: 'Gracias' })
    expect(writes).toHaveLength(4)
    vi.useRealTimers()
  })
})
