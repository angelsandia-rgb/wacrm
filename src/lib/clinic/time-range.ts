// ============================================================
// Named date ranges (Hoy / Mañana / Esta semana / Este mes) resolved to
// UTC instants in a given IANA timezone. Pure; used by the appointments
// list and the calendar. DST-safe enough for slot/range purposes (see
// the note in availability.ts).
// ============================================================

const MIN = 60_000

export type AppointmentRange = 'today' | 'tomorrow' | 'week' | 'month' | 'all'

export const APPOINTMENT_RANGES: readonly AppointmentRange[] = [
  'today',
  'tomorrow',
  'week',
  'month',
  'all',
] as const

export function isAppointmentRange(v: unknown): v is AppointmentRange {
  return typeof v === 'string' && (APPOINTMENT_RANGES as readonly string[]).includes(v)
}

function tzOffsetMinutes(at: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>
  const hour = p.hour === '24' ? '00' : p.hour
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(hour),
    Number(p.minute),
    Number(p.second),
  )
  return Math.round((asIfUtc - at.getTime()) / MIN)
}

/** The UTC instant for local `yyyy-mm-dd` at 00:00 in `tz`. */
export function localMidnightUTC(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0)
  let off = tzOffsetMinutes(new Date(guess), tz)
  let result = guess - off * MIN
  off = tzOffsetMinutes(new Date(result), tz)
  result = guess - off * MIN
  return new Date(result)
}

/** `yyyy-mm-dd` (in `tz`) parts of `instant`. */
export function ymdInTz(instant: Date, tz: string): [number, number, number] {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>
  return [Number(p.year), Number(p.month), Number(p.day)]
}

function addDaysUTC(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}

/**
 * `{ from, to }` ISO instants for a named range, Monday-start week,
 * calendar month. `to` is exclusive. `all` → a wide ±1y window.
 */
export function rangeBounds(range: AppointmentRange, tz: string, now: Date = new Date()): {
  from: string
  to: string
} {
  const [y, m, d] = ymdInTz(now, tz)
  const todayStart = localMidnightUTC(y, m, d, tz)

  if (range === 'today') {
    return { from: todayStart.toISOString(), to: addDaysUTC(todayStart, 1).toISOString() }
  }
  if (range === 'tomorrow') {
    return {
      from: addDaysUTC(todayStart, 1).toISOString(),
      to: addDaysUTC(todayStart, 2).toISOString(),
    }
  }
  if (range === 'week') {
    // Monday as the first day.
    const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() // 0=Sun
    const backToMon = (dow + 6) % 7
    const weekStart = addDaysUTC(todayStart, -backToMon)
    return { from: weekStart.toISOString(), to: addDaysUTC(weekStart, 7).toISOString() }
  }
  if (range === 'month') {
    const monthStart = localMidnightUTC(y, m, 1, tz)
    const nextMonth = m === 12 ? localMidnightUTC(y + 1, 1, 1, tz) : localMidnightUTC(y, m + 1, 1, tz)
    return { from: monthStart.toISOString(), to: nextMonth.toISOString() }
  }
  // all
  return {
    from: addDaysUTC(todayStart, -365).toISOString(),
    to: addDaysUTC(todayStart, 366).toISOString(),
  }
}

// ── Dashboard period picker ─────────────────────────────────
export type DashboardPeriod = 'today' | 'week' | 'month' | 'last_month' | 'last_30'

export const DASHBOARD_PERIODS: readonly DashboardPeriod[] = [
  'today',
  'week',
  'month',
  'last_month',
  'last_30',
] as const

export function isDashboardPeriod(v: unknown): v is DashboardPeriod {
  return typeof v === 'string' && (DASHBOARD_PERIODS as readonly string[]).includes(v)
}

/** `{ from, to }` (ISO, `to` exclusive) for a clinic dashboard period. */
export function dashboardPeriodBounds(period: DashboardPeriod, tz: string, now: Date = new Date()): {
  from: string
  to: string
} {
  const [y, m, d] = ymdInTz(now, tz)
  const todayStart = localMidnightUTC(y, m, d, tz)

  if (period === 'today') return { from: todayStart.toISOString(), to: addDaysUTC(todayStart, 1).toISOString() }
  if (period === 'week') return rangeBounds('week', tz, now)
  if (period === 'month') return rangeBounds('month', tz, now)
  if (period === 'last_30') {
    return { from: addDaysUTC(todayStart, -30).toISOString(), to: addDaysUTC(todayStart, 1).toISOString() }
  }
  // last_month — the previous calendar month
  const monthStart = localMidnightUTC(y, m, 1, tz)
  const prevMonthStart = m === 1 ? localMidnightUTC(y - 1, 12, 1, tz) : localMidnightUTC(y, m - 1, 1, tz)
  return { from: prevMonthStart.toISOString(), to: monthStart.toISOString() }
}
