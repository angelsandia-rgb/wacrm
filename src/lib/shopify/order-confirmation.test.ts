import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ record: vi.fn(), sweep: vi.fn() }))
vi.mock('./notification-jobs', () => ({ runOrderNotificationSweep: m.sweep }))
import { resolveOrderConfirmation } from './order-confirmation'

const db = { rpc: m.record }
beforeEach(() => {
  vi.clearAllMocks()
  m.record.mockResolvedValue({ data: 'Pedido guardado', error: null })
  m.sweep.mockResolvedValue({ sent: 0, pending: 1, skipped: 0 })
})

describe('persisting customer order decisions', () => {
  const pending = { dealId: 'd', orderId: 'o', orderName: '#1005', pipelineId: 'p' }
  it.each(['confirm', 'cancel'] as const)('commits %s and its recovery job before trying Shopify', async (decision) => {
    await resolveOrderConfirmation({ db: db as never, accountId: 'a', conversationId: 'c', pending, decision, handoffAgentId: 'agent' })
    expect(m.record).toHaveBeenCalledWith('record_shopify_order_decision', {
      p_account_id: 'a', p_deal_id: 'd', p_order_id: 'o', p_conversation_id: 'c', p_decision: decision, p_handoff_agent_id: 'agent',
    })
    expect(m.sweep).toHaveBeenCalledWith(db, 'a', 'o:decision')
    expect(m.record.mock.invocationCallOrder[0]).toBeLessThan(m.sweep.mock.invocationCallOrder[0])
  })
  it('does not claim success or attempt remote effects if the transaction failed', async () => {
    m.record.mockResolvedValueOnce({ error: { message: 'notification insert failed' } })
    await expect(resolveOrderConfirmation({ db: db as never, accountId: 'a', conversationId: 'c', pending, decision: 'cancel' }))
      .rejects.toThrow('Cannot save order confirmation: notification insert failed')
    expect(m.sweep).not.toHaveBeenCalled()
  })
})
