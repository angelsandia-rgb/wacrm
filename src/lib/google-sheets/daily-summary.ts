import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { localMidnightUTC } from '@/lib/clinic/time-range'
import { dateKeyInZone } from '@/lib/timezone'

// ============================================================
// Yesterday's activity totals for one account — the `daily.summary`
// event payload (cron: /api/google-sheets/daily-summary/cron).
// Counts use head:true (no 1000-row cap); sums page through rows.
// ============================================================

export interface DailySummary {
  date: string
  messages_in: number
  messages_out: number
  conversations_new: number
  conversations_closed: number
  leads_new: number
  quotes: number
  quotes_total: number
  deals_won: number
  deals_won_total: number
  deals_lost: number
}

/** [start, end) of the calendar day before `now` in `timeZone`, plus its yyyy-mm-dd key. */
export function yesterdayWindow(timeZone: string, now = new Date()): { date: string; start: string; end: string } {
  const today = dateKeyInZone(now, timeZone)
  const [y, m, d] = today.split('-').map(Number)
  const end = localMidnightUTC(y, m, d, timeZone)
  const date = dateKeyInZone(new Date(end.getTime() - 12 * 3_600_000), timeZone)
  const [py, pm, pd] = date.split('-').map(Number)
  return { date, start: localMidnightUTC(py, pm, pd, timeZone).toISOString(), end: end.toISOString() }
}

export async function computeDailySummary(
  db: SupabaseClient,
  accountId: string,
  timeZone: string,
  now = new Date(),
): Promise<DailySummary> {
  const { date, start, end } = yesterdayWindow(timeZone, now)

  const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count: c, error } = await q
    if (error) throw error
    return c ?? 0
  }
  const messages = (outbound: boolean) => {
    const q = db
      .from('messages')
      .select('id, conversations!inner(account_id)', { count: 'exact', head: true })
      .eq('conversations.account_id', accountId)
      .neq('content_type', 'internal_note')
      .gte('created_at', start)
      .lt('created_at', end)
    return outbound ? q.neq('sender_type', 'customer') : q.eq('sender_type', 'customer')
  }
  const inWindow = (table: string, column: string) =>
    db.from(table).select('id', { count: 'exact', head: true }).eq('account_id', accountId).gte(column, start).lt(column, end)

  const [messagesIn, messagesOut, convNew, convClosed, leads, dealsLost, quotes, won] = await Promise.all([
    count(messages(false)),
    count(messages(true)),
    count(inWindow('conversations', 'created_at')),
    count(inWindow('conversations', 'closed_at')),
    count(inWindow('contacts', 'created_at')),
    count(inWindow('deals', 'lost_at')),
    fetchAllRows<{ id: string; total: number | string | null }>(
      () => db.from('quotes').select('id, total').eq('account_id', accountId).gte('created_at', start).lt('created_at', end),
      { label: 'daily summary quotes' },
    ),
    fetchAllRows<{ id: string; value: number | string | null }>(
      () =>
        db.from('deals').select('id, value').eq('account_id', accountId).eq('status', 'won').gte('won_at', start).lt('won_at', end),
      { label: 'daily summary won deals' },
    ),
  ])
  const sum = (xs: (number | string | null)[]) => Math.round(xs.reduce<number>((a, x) => a + Number(x ?? 0), 0) * 100) / 100

  return {
    date,
    messages_in: messagesIn,
    messages_out: messagesOut,
    conversations_new: convNew,
    conversations_closed: convClosed,
    leads_new: leads,
    quotes: quotes.length,
    quotes_total: sum(quotes.map((q) => q.total)),
    deals_won: won.length,
    deals_won_total: sum(won.map((d) => d.value)),
    deals_lost: dealsLost,
  }
}
