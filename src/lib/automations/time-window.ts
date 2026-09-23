// ============================================================
// `time_of_day` automation condition — "is `now` inside HH:mm-HH:mm?",
// read in the ACCOUNT's timezone. The server runs in UTC, so the old
// `now.getHours()` put an "18:00-09:00 out of office" window six hours
// off for a Guatemala account (firing 12:00-18:00 local).
// ============================================================

/** Minutes since local midnight for `date` as read in `timeZone`
 *  (falls back to UTC for a missing or invalid zone). */
export function minutesInTimeZone(date: Date, timeZone: string | null | undefined): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    return hour * 60 + minute
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes()
  }
}

/**
 * `operand` is "HH:mm-HH:mm" (24h). True when `now`, in `timeZone`, falls
 * in [from, to); an over-midnight range like "18:00-09:00" wraps.
 * A malformed operand is never "inside".
 */
export function isWithinTimeWindow(
  operand: string | null | undefined,
  now: Date,
  timeZone: string | null | undefined,
): boolean {
  const [from, to] = (operand ?? '').split('-')
  if (!from || !to) return false
  const parse = (s: string) => {
    const [h, m] = s.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const mins = minutesInTimeZone(now, timeZone)
  const f = parse(from)
  const t = parse(to)
  return f <= t ? mins >= f && mins < t : mins >= f || mins < t
}
