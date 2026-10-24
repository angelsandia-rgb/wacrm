import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ send: vi.fn(), alert: vi.fn(), resolve: vi.fn(), type: 'ai_handoff' }))
vi.mock('@/lib/push/send', () => ({ sendPushToUser: h.send }))
vi.mock('@/lib/push/vapid', () => ({ isPushConfigured: () => true }))
vi.mock('@/lib/observability/alerts', () => ({ dispatchSystemAlert: h.alert, resolveSystemAlert: h.resolve }))
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({ from(table: string) {
  const result = { data: table === 'notifications'
    ? { id: 'n', account_id: 'hotel', user_id: 'ana', type: h.type, title: 'Requiere atención', body: 'Acción: Confirmar disponibilidad', conversation_id: 'c' }
    : table === 'messages' ? [{ sender_type: 'customer', content_type: 'text', content_text: 'Adjunto deposito', created_at: '2026-10-24T18:00:00Z' }]
    : { id: 'c', contact: { name: 'Pineda' }, contacts: { name: 'Pineda' } }, error: null }
  const chain = { select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => result, then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) }
  return chain
} }) }))
import { POST } from './route'

describe('push attention delivery monitoring', () => {
  beforeEach(() => { vi.stubEnv('PUSH_FANOUT_SECRET', 'test-push-secret'); h.send.mockReset(); h.alert.mockReset(); h.resolve.mockReset(); h.type = 'ai_handoff' })
  afterEach(() => vi.unstubAllEnvs())
  const request = () => new Request('http://localhost/api/push/fanout', { method: 'POST', headers: { 'x-cron-secret': 'test-push-secret', 'content-type': 'application/json' }, body: JSON.stringify({ notification_id: 'n' }) })
  it('enriches assignment pushes with the actual customer request instead of the generic instruction', async () => {
    h.type = 'conversation_assigned'
    h.send.mockResolvedValue({ sent: 1, pruned: 0 })
    await POST(request())
    expect(h.send).toHaveBeenCalledWith(expect.anything(), 'ana', expect.objectContaining({
      title: 'Conversación asignada: Pineda', body: expect.stringContaining('comprobante de pago'), url: '/inbox?c=c',
    }))
    expect(h.send.mock.calls[0][2].body).toContain('Revise el comprobante')
    expect(h.send.mock.calls[0][2].body).toContain('Adjunto deposito')
  })
  it('records an operational warning when no device accepts the push', async () => {
    h.send.mockResolvedValue({ sent: 0, pruned: 1 })
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'hotel', source: 'push_delivery', dedupKey: 'push_delivery:hotel:ana', detail: expect.objectContaining({ conversation_id: 'c', pruned_devices: 1 }) }))
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it('clears a prior delivery warning after provider acceptance and includes the contact', async () => {
    h.send.mockResolvedValue({ sent: 1, pruned: 0 })
    await POST(request())
    expect(h.resolve).toHaveBeenCalledWith('push_delivery:hotel:ana')
    expect(h.send).toHaveBeenCalledWith(expect.anything(), 'ana', expect.objectContaining({ title: 'Requiere atención: Pineda', url: '/inbox?c=c' }))
    expect(h.alert).not.toHaveBeenCalled()
  })
})
