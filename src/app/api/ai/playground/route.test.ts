import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: {} as Record<string, unknown>,
  promptArgs: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'acct-1',
    userId: 'user-1',
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: h.account, error: null }) }),
        }),
      }),
    },
  }),
  toErrorResponse: (err: unknown) => Response.json({ error: String(err) }, { status: 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkSharedRateLimit: async () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { aiDraft: {} },
}))
vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: async () => ({ systemPrompt: 'Eres el asistente.', askCustomerTaxInfo: false }),
}))
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledge: async () => [] }))
vi.mock('@/lib/ai/catalog-context', () => ({ loadCatalogContext: async () => null }))
vi.mock('@/lib/ai/business-metrics', () => ({
  loadBusinessMetrics: async () => null,
  metricsGrounding: () => '',
}))
vi.mock('@/lib/ai/quick-reply-context', () => ({ loadQuickReplyContext: async () => null }))
vi.mock('@/lib/ai/auto-reply', () => ({
  loadHotelCategoryBanners: async () => [{ name: 'Habitaciones', hasWeekendVariant: true }],
}))
vi.mock('@/lib/ai/defaults', () => ({
  buildSystemPrompt: (args: Record<string, unknown>) => {
    h.promptArgs = args
    return 'PROMPT'
  },
}))
vi.mock('@/lib/ai/generate', () => ({
  generateReply: async () => ({ text: 'Hola', handoff: false }),
}))

import { POST } from './route'

const send = (messages: { role: string; content: string }[]) =>
  POST(new Request('https://crm.test/api/ai/playground', {
    method: 'POST',
    body: JSON.stringify({ messages }),
  }))

beforeEach(() => {
  h.promptArgs = null
})

describe('AI playground prompt context', () => {
  it('gives a hotel account the same vertical context as the live bot', async () => {
    h.account = { industry_vertical: 'hotel', timezone: 'America/Guatemala', catalog_delivery_mode: 'photos', restaurant_menu_url: 'https://x/menu.pdf' }
    const res = await send([{ role: 'user', content: 'Hola, precios?' }])
    expect(res.status).toBe(200)
    expect(h.promptArgs).toMatchObject({
      hotelReservations: true,
      hotelIsFirstReply: true,
      hotelCategoryBanners: [{ name: 'Habitaciones', hasWeekendVariant: true }],
      restaurantMenu: true,
      catalogDeliveryMode: 'photos',
      clinicGuardrails: false,
    })
  })

  it('only treats the first turn as the hotel welcome', async () => {
    h.account = { industry_vertical: 'hotel' }
    await send([
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Bienvenido' },
      { role: 'user', content: 'Habitación para 2' },
    ])
    expect(h.promptArgs?.hotelIsFirstReply).toBe(false)
  })

  it('applies clinic guardrails and no hotel context for a clinic', async () => {
    h.account = { industry_vertical: 'clinica' }
    await send([{ role: 'user', content: 'Quiero una cita' }])
    expect(h.promptArgs).toMatchObject({ clinicGuardrails: true, hotelReservations: false, hotelCategoryBanners: [] })
  })
})
