import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkSharedRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { loadCatalogContext } from '@/lib/ai/catalog-context'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { describeNowInZone, describeUpcomingWeekdaysInZone } from '@/lib/timezone'
import { loadQuickReplyContext } from '@/lib/ai/quick-reply-context'
import { loadHotelCategoryBanners } from '@/lib/ai/auto-reply'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'
import { loadBusinessMetrics, metricsGrounding } from '@/lib/ai/business-metrics'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Builds the
 * `auto_reply` system prompt with the same ACCOUNT-level context the live
 * bot uses — knowledge base, catalog + delivery mode, quick replies, the
 * industry vertical (hotel reservation markers, category banners and the
 * first-reply welcome; clinic guardrails), restaurant menu, timezone — so a
 * prompt change can be tested before it reaches customers. What it can't
 * simulate is CONVERSATION-level state (a reservation in progress, a stay
 * estimate, the patient's appointment, facts known about a real contact,
 * the flow directive), since there is no real conversation. Markers the
 * model emits are returned as-is so they can be inspected. Reads the
 * config even when the master switch is off (requireActive:false).
 * Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = await checkSharedRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages),
    )
    const metrics = await loadBusinessMetrics(supabase, accountId)
    const catalog = await loadCatalogContext(supabase, accountId)
    const { data: account } = await supabase
      .from('accounts')
      .select('timezone, industry_vertical, catalog_delivery_mode, restaurant_menu_url')
      .eq('id', accountId)
      .maybeSingle()
    const timeZone = (account?.timezone as string | null | undefined)?.trim() || 'UTC'
    const isHotel = account?.industry_vertical === 'hotel'
    const isClinic = account?.industry_vertical === 'clinica'
    const [quickReplies, hotelCategoryBanners] = await Promise.all([
      loadQuickReplyContext(supabase, accountId).catch(() => null),
      isHotel ? loadHotelCategoryBanners(supabase, accountId).catch(() => []) : Promise.resolve([]),
    ])

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      catalog,
      catalogDeliveryMode:
        (account?.catalog_delivery_mode as 'digital' | 'pdf' | 'photos' | undefined) ?? 'digital',
      quickReplies,
      askCustomerTaxInfo: config.askCustomerTaxInfo,
      hotelReservations: isHotel,
      restaurantMenu: Boolean((account?.restaurant_menu_url as string | null | undefined)?.trim()),
      hotelCategoryBanners,
      // Same rule as the live bot: no assistant turn yet = first reply.
      hotelIsFirstReply: isHotel && !messages.some((m) => m.role === 'assistant'),
      clinicGuardrails: isClinic,
      currentDate: describeNowInZone(timeZone),
      upcomingWeekdays: describeUpcomingWeekdaysInZone(timeZone),
    }) + metricsGrounding(metrics)

    const { text, handoff } = await generateReply({ config, systemPrompt, messages })
    return NextResponse.json({ reply: text, handoff })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
