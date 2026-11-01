import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import type { ChatMessage } from '@/lib/ai/types'
import { notifyConversationClosed } from '@/lib/automations/events'

// ============================================================
// Close insights (respond.io parity): when a conversation closes, the
// account's own AI picks a category, writes a short summary and labels
// the customer's sentiment. Runs from /api/conversations/cron, not
// inline, so every close path (inbox, AI action, automation, auto-close)
// is covered by the `closed_at` trigger of migration 169.
//
// Auto-close lives here too: open/pending threads with no message for
// the account's `auto_close_after_days` are closed (then analysed).
// ============================================================

export const CLOSE_SENTIMENTS = ['positive', 'neutral', 'negative'] as const
export type CloseSentiment = (typeof CLOSE_SENTIMENTS)[number]

export const DEFAULT_CLOSE_CATEGORIES = ['Consulta general', 'Ventas', 'Pago', 'Soporte', 'Otros']
const MAX_CATEGORIES = 20
const MAX_INSIGHTS_PER_RUN = 20
const MAX_AUTO_CLOSE_PER_RUN = 500
const TRANSCRIPT_MESSAGES = 40
// Older closes are left alone (e.g. the backlog when an account first
// turns the feature on).
const INSIGHTS_LOOKBACK_DAYS = 7

export interface CloseInsights {
  category: string
  summary: string
  sentiment: CloseSentiment
  sentimentReason: string
}

export interface CloseConfigInput {
  insights_enabled: boolean
  categories: string[]
  auto_close_after_days: number | null
}

/** Validate the settings form body. */
export function normalizeCloseConfig(
  body: Record<string, unknown>,
): { ok: true; value: CloseConfigInput } | { ok: false; error: string } {
  const raw = Array.isArray(body.categories) ? body.categories : []
  const categories = Array.from(
    new Set(
      raw
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim().slice(0, 60))
        .filter(Boolean),
    ),
  )
  if (categories.length === 0) return { ok: false, error: 'Agrega al menos una categoría.' }
  if (categories.length > MAX_CATEGORIES) return { ok: false, error: `Máximo ${MAX_CATEGORIES} categorías.` }
  let days: number | null = null
  const rawDays = body.auto_close_after_days
  if (rawDays !== null && rawDays !== undefined && rawDays !== '') {
    days = Number(rawDays)
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return { ok: false, error: 'El cierre automático debe ser de 1 a 90 días.' }
    }
  }
  return {
    ok: true,
    value: { insights_enabled: body.insights_enabled === true, categories, auto_close_after_days: days },
  }
}

export function buildCloseInsightsPrompt(categories: string[]): string {
  return [
    'Eres un analista de atención al cliente. Lee la conversación que se acaba de cerrar y responde SOLO con un objeto JSON, sin texto adicional:',
    '{"category": "...", "summary": "...", "sentiment": "positive|neutral|negative", "sentiment_reason": "..."}',
    `- "category": exactamente una de estas: ${categories.map((c) => JSON.stringify(c)).join(', ')}.`,
    '- "summary": 1 a 3 oraciones en español: qué quería el cliente, qué se resolvió y qué queda pendiente.',
    '- "sentiment": cómo sonaba el CLIENTE (no el negocio) al final de la conversación.',
    '- "sentiment_reason": una oración en español que justifique el sentimiento.',
  ].join('\n')
}

/** Parse the model's JSON; null when it isn't usable. An unknown
 *  category falls back to the last one ("Otros"). */
export function parseCloseInsights(text: string, categories: string[]): CloseInsights | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(match[0])
  } catch {
    return null
  }
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  const sentiment = typeof obj.sentiment === 'string' ? obj.sentiment.trim().toLowerCase() : ''
  if (!summary || !(CLOSE_SENTIMENTS as readonly string[]).includes(sentiment)) return null
  const wanted = typeof obj.category === 'string' ? obj.category.trim().toLowerCase() : ''
  const category = categories.find((c) => c.toLowerCase() === wanted) ?? categories[categories.length - 1]
  return {
    category,
    summary: summary.slice(0, 1000),
    sentiment: sentiment as CloseSentiment,
    sentimentReason: typeof obj.sentiment_reason === 'string' ? obj.sentiment_reason.trim().slice(0, 300) : '',
  }
}

interface ConfigRow {
  account_id: string
  insights_enabled: boolean
  categories: string[] | null
  auto_close_after_days: number | null
}

async function loadConfigs(db: SupabaseClient): Promise<ConfigRow[]> {
  const { data, error } = await db
    .from('conversation_close_config')
    .select('account_id, insights_enabled, categories, auto_close_after_days')
    .or('insights_enabled.eq.true,auto_close_after_days.not.is.null')
  if (error) throw error
  return (data ?? []) as ConfigRow[]
}

export async function runAutoClose(
  db: SupabaseClient,
  now: number = Date.now(),
): Promise<{ autoClosed: number }> {
  let autoClosed = 0
  for (const cfg of await loadConfigs(db)) {
    if (!cfg.auto_close_after_days) continue
    const cutoff = new Date(now - cfg.auto_close_after_days * 86_400_000).toISOString()
    const { data: stale } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', cfg.account_id)
      .in('status', ['open', 'pending'])
      .lt('last_message_at', cutoff)
      .limit(MAX_AUTO_CLOSE_PER_RUN)
    const ids = (stale ?? []).map((r) => r.id as string)
    if (ids.length === 0) continue
    // Re-check the cutoff in the UPDATE so a message that lands between
    // the read and the write keeps its thread open.
    const { data, error } = await db
      .from('conversations')
      .update({ status: 'closed' })
      .in('id', ids)
      .in('status', ['open', 'pending'])
      .lt('last_message_at', cutoff)
      .select('id')
    if (error) {
      console.error('[close-insights] auto-close failed:', cfg.account_id, error.message)
      continue
    }
    // Outbound webhook + conversation_closed automations, like any close.
    for (const row of data ?? []) {
      await notifyConversationClosed(db, {
        accountId: cfg.account_id,
        conversationId: row.id as string,
        closedBy: 'auto_close',
      })
    }
    autoClosed += data?.length ?? 0
  }
  return { autoClosed }
}

export async function runCloseInsights(
  db: SupabaseClient,
  now: number = Date.now(),
): Promise<{ analysed: number; failed: number }> {
  let analysed = 0
  let failed = 0
  const since = new Date(now - INSIGHTS_LOOKBACK_DAYS * 86_400_000).toISOString()
  for (const cfg of await loadConfigs(db)) {
    if (!cfg.insights_enabled) continue
    const config = await loadAiConfig(db, cfg.account_id, { requireActive: false }).catch(() => null)
    if (!config) continue
    const categories = cfg.categories?.length ? cfg.categories : DEFAULT_CLOSE_CATEGORIES
    const { data: pending } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', cfg.account_id)
      .eq('status', 'closed')
      .is('close_insights_at', null)
      .gte('closed_at', since)
      .order('closed_at', { ascending: true })
      .limit(MAX_INSIGHTS_PER_RUN)
    for (const conv of pending ?? []) {
      // Claim first: a provider failure must not retry every 5 minutes.
      const { data: claimed } = await db
        .from('conversations')
        .update({ close_insights_at: new Date(now).toISOString() })
        .eq('id', conv.id)
        .is('close_insights_at', null)
        .select('id')
      if (!claimed?.length) continue
      try {
        const { data: rows } = await db
          .from('messages')
          .select('sender_type, content_text')
          .eq('conversation_id', conv.id)
          .not('content_text', 'is', null)
          .order('created_at', { ascending: false })
          .limit(TRANSCRIPT_MESSAGES)
        const transcript = (rows ?? [])
          .reverse()
          .map((m) => `${m.sender_type === 'customer' ? 'Cliente' : 'Negocio'}: ${m.content_text}`)
          .join('\n')
        if (!transcript) continue
        const messages: ChatMessage[] = [{ role: 'user', content: transcript }]
        const { text, usage } = await generateReply({
          config,
          systemPrompt: buildCloseInsightsPrompt(categories),
          messages,
        })
        void logAiUsage(db, {
          accountId: cfg.account_id,
          conversationId: conv.id,
          mode: 'close_insights',
          provider: config.provider,
          model: config.model,
          usage,
        })
        const insights = parseCloseInsights(text, categories)
        if (!insights) {
          failed++
          continue
        }
        await db
          .from('conversations')
          .update({
            close_category: insights.category,
            close_summary: insights.summary,
            close_sentiment: insights.sentiment,
            close_sentiment_reason: insights.sentimentReason || null,
          })
          .eq('id', conv.id)
        analysed++
      } catch (err) {
        failed++
        console.error('[close-insights] analysis failed:', conv.id, err instanceof Error ? err.message : err)
      }
    }
  }
  return { analysed, failed }
}
