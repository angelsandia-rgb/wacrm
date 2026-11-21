import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ preference: vi.fn(), send: vi.fn() }))
vi.mock('./commercial-preferences', () => ({ contactMutesCommercial: m.preference }))
vi.mock('./muted-contact', () => ({ contactMutesAi: async () => false }))
vi.mock('./auto-reply-schedule', () => ({
  autoReplyScheduleForAccount: () => ({}), withinAiAttentionHours: () => true,
  OutsideAiAttentionHours: class extends Error {},
}))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: m.send, SendMessageError: class extends Error {} }))
vi.mock('@/lib/observability/alerts', () => ({ dispatchSystemAlert: vi.fn() }))
vi.mock('./human-reply', () => ({ teammateTookOver: async () => false }))
import { runFollowupSweep } from './followups-sweep'

function database() {
  return { from(table: string) {
    const filters: Record<string, unknown> = {}
    let columns = ''
    const c = {
      select: (value: string) => { columns = value; return c },
      eq: (key: string, value: unknown) => { filters[key] = value; return c },
      is: () => c, or: () => c, order: () => c, limit: () => c, gt: () => c, gte: () => c,
      insert: async () => ({ error: null }),
      maybeSingle: async () => ({ data: { name: 'Cliente' }, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data:
        table === 'ai_configs' ? [{ account_id: 'a', followups: [{ after_minutes: 60, type: 'text', text: '¿Le ayudo a elegir?' }], followups_goal: 'reply', followups_business_hours_only: false, followups_window_start_hour: 8, followups_window_end_hour: 20, accounts: { timezone: 'America/Guatemala', industry_vertical: 'dropshipping' } }]
        : table === 'conversations' ? [{ id: 'conv', contact_id: 'ct', ai_context_reset_at: null }]
        : table === 'messages' ? columns === 'sender_type, created_at' ? [{ sender_type: 'bot', created_at: '2026-11-13T16:01:00Z' }]
          : filters.sender_type === 'customer' ? [{ created_at: '2026-11-13T16:00:00Z', content_text: 'Me interesa el sofá' }]
          : [{ content_text: '¿Lo busca para su casa?' }]
        : [], error: null }),
    }
    return c
  } } as never
}

beforeEach(() => { m.preference.mockReset().mockResolvedValue(false); m.send.mockReset().mockResolvedValue({ messageId: 'sent' }) })
const now = new Date('2026-11-13T18:00:00Z')
describe('commercial exclusions in follow-up delivery', () => {
  it('does not evaluate a commercial nudge for an unsubscribed contact', async () => {
    m.preference.mockResolvedValue(true)
    const result = await runFollowupSweep(database(), now)
    expect(result.skipped).toBe(1)
    expect(m.send).not.toHaveBeenCalled()
    expect(m.preference).toHaveBeenCalledWith(expect.anything(), 'a', 'ct')
  })
  it('rechecks opt-out immediately before sending', async () => {
    m.preference.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const result = await runFollowupSweep(database(), now)
    expect(m.preference).toHaveBeenCalledTimes(2)
    expect(result.skipped).toBe(1)
    expect(m.send).not.toHaveBeenCalled()
  })
  it('postpones marketing if the final preference read fails', async () => {
    m.preference.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('database unavailable'))
    const result = await runFollowupSweep(database(), now)
    expect(result.skipped).toBe(1)
    expect(m.send).not.toHaveBeenCalled()
  })
  it('keeps eligible commercial follow-ups working', async () => {
    const result = await runFollowupSweep(database(), now)
    expect(result.sent).toBe(1)
    expect(m.send).toHaveBeenCalledTimes(1)
  })
})
