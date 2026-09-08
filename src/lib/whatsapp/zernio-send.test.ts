import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendZernioTemplate: vi.fn(),
  createZernioConversation: vi.fn(),
}))

vi.mock('@/lib/zernio/api', () => ({
  sendZernioText: vi.fn(),
  sendZernioMedia: vi.fn(),
  sendZernioTemplate: h.sendZernioTemplate,
  sendZernioButtons: vi.fn(),
  sendZernioInteractive: vi.fn(),
  createZernioConversation: h.createZernioConversation,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `dec:${v}` }))

import { sendWhatsAppTemplateViaZernio, type ZernioSendContext } from './zernio-send'

const ctxNoThread: ZernioSendContext = {
  config: { zernio_api_key: 'enc', zernio_account_id: 'z-acct' },
  zernioConversationId: null,
}
const ctxWithThread: ZernioSendContext = {
  config: { zernio_api_key: 'enc', zernio_account_id: 'z-acct' },
  zernioConversationId: 'conv-xyz',
}

beforeEach(() => {
  h.sendZernioTemplate.mockReset().mockResolvedValue({ messageId: 'in-thread-msg' })
  h.createZernioConversation.mockReset().mockResolvedValue({
    messageId: 'cold-msg',
    conversationId: 'new-conv-24hex',
  })
})

describe('sendWhatsAppTemplateViaZernio', () => {
  it('opens a conversation with the template when there is no thread + a recipient phone', async () => {
    const res = await sendWhatsAppTemplateViaZernio(ctxNoThread, {
      templateName: 'promo',
      language: 'es',
      params: ['Juan'],
      recipientPhone: '+502 5555-1234',
    })

    expect(h.createZernioConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'z-acct',
        participantId: '50255551234', // digits only
        templateName: 'promo',
        templateLanguage: 'es',
        templateParams: ['Juan'],
      }),
    )
    expect(h.sendZernioTemplate).not.toHaveBeenCalled()
    expect(res).toEqual({ messageId: 'cold-msg', zernioConversationId: 'new-conv-24hex' })
  })

  it('sends into the existing thread (no cold-open) when a conversation id is present', async () => {
    const res = await sendWhatsAppTemplateViaZernio(ctxWithThread, {
      templateName: 'promo',
      language: 'es',
      params: ['Juan'],
      recipientPhone: '50255551234',
    })
    expect(h.createZernioConversation).not.toHaveBeenCalled()
    expect(h.sendZernioTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-xyz', templateName: 'promo' }),
    )
    expect(res).toEqual({ messageId: 'in-thread-msg' })
  })

  it('still throws "no conversation yet" when there is no thread AND no phone (flow/automation reply)', async () => {
    await expect(
      sendWhatsAppTemplateViaZernio(ctxNoThread, { templateName: 'promo', language: 'es' }),
    ).rejects.toThrow(/No Zernio conversation exists yet/)
  })

  it('forwards a media-header override to createZernioConversation', async () => {
    await sendWhatsAppTemplateViaZernio(ctxNoThread, {
      templateName: 'promo',
      language: 'en',
      recipientPhone: '50255551234',
      template: { header_type: 'image' } as never,
      messageParams: { headerMediaUrl: 'https://x/i.jpg', body: ['A'] },
    })
    expect(h.createZernioConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        headerMedia: { type: 'image', link: 'https://x/i.jpg' },
        templateParams: ['A'],
      }),
    )
  })
})
