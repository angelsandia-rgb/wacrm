// ============================================================
// Free-slot engine for the clinic vertical — pure, no I/O, unit-tested.
//
// Given a doctor's recurring weekly availability, their one-off time
// off / extra hours, the appointments already on their calendar, and a
// service duration, it returns the bookable start times in a window.
//
// All wall-clock inputs (`day_of_week`, `HH:MM`) are interpreted in the
// clinic's IANA timezone. Guatemala (the launch market) has no DST; the
// zoned<->UTC conversion below is a two-pass offset probe that is exact
// for DST-free zones and off by at most the DST gap for zones that do
// observe it — acceptable for slot suggestions, and documented so a
// future maintainer targeting a DST market knows to revisit it.
// ============================================================

export interface AvailabilityBlock {
  /** 0 = Sunday … 6 = Saturday (JS `Date.getDay()`). */
  day_of_week: number
  /** `HH:MM` 24h, clinic-local wall time. */
  start_time: string
  end_time: string
}

export interface TimeOffBlock {
  starts_at: string // ISO
  ends_at: string // ISO
  /** false = blocked (vacation / day off); true = an EXTRA working
   *  block outside the recurring availability. */
  is_extra_hours: boolean
}

export interface BusyInterval {
  start: string // ISO
  end: string // ISO
}

export interface FreeSlotQuery {
  timezone: string
  /** Window to search, ISO. */
  from: string
  to: string
  /** Length of the appointment being booked. */
  durationMinutes: number
  /** Slot start granularity. Defaults to `durationMinutes`. */
  stepMinutes?: number
  availability: AvailabilityBlock[]
  timeOff?: TimeOffBlock[]
  /** Appointments already on the doctor's calendar (exclude cancelled). */
  busy?: BusyInterval[]
  /** Slots starting before this instant are dropped. Defaults to now. */
  now?: string
  /** Safety cap on the window length in days (default 62). */
  maxWindowDays?: number
}

export interface FreeSlot {
  start: string // ISO (UTC `Z`)
  end: string // ISO (UTC `Z`)
}

interface Interval {
  start: number
  end: number
}

const MIN = 60_000
const DAY = 86_400_000
const MAX_SLOT_RESULTS = 2_000
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** Offset (minutes) of `tz` from UTC at instant `at`. East of UTC is
 *  positive. */
function tzOffsetMinutes(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>
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

/** A clinic-local wall time (`yyyy-mm-dd` + `HH:MM`) → the UTC instant. */
function zonedWallToUtc(dateKey: string, hh: number, mm: number, tz: string): number {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0)
  // First correction with the offset at the guessed instant…
  let off = tzOffsetMinutes(new Date(guess), tz)
  let result = guess - off * MIN
  // …then re-probe at the corrected instant (handles a guess that
  // landed on the wrong side of an offset change).
  off = tzOffsetMinutes(new Date(result), tz)
  result = guess - off * MIN
  return result
}

/** `yyyy-mm-dd` for `instant` read in `tz`. */
function dateKeyInTz(instant: number, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>
  return `${p.year}-${p.month}-${p.day}`
}

/** JS weekday (0=Sun) for `dateKey` (noon-anchored so tz can't slip the day). */
function weekdayOfDateKey(dateKey: string): number {
  const [y, mo, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay()
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const cur of sorted) {
    const last = out[out.length - 1]
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end)
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

/** `base` minus every interval in `cuts`. */
function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  const merged = mergeIntervals(cuts)
  let acc = mergeIntervals(base)
  for (const cut of merged) {
    const next: Interval[] = []
    for (const iv of acc) {
      if (cut.end <= iv.start || cut.start >= iv.end) {
        next.push(iv)
        continue
      }
      if (cut.start > iv.start) next.push({ start: iv.start, end: cut.start })
      if (cut.end < iv.end) next.push({ start: cut.end, end: iv.end })
    }
    acc = next
  }
  return acc
}

/**
 * The bookable start times for a service in the requested window.
 * Deterministic, sorted ascending, no duplicates.
 */
export function computeFreeSlots(q: FreeSlotQuery): FreeSlot[] {
  const duration = Math.round(q.durationMinutes)
  if (!Number.isFinite(duration) || duration <= 0) return []
  const step = Math.round(q.stepMinutes ?? duration)
  if (!Number.isFinite(step) || step <= 0) return []

  const fromMs = new Date(q.from).getTime()
  const toMsRaw = new Date(q.to).getTime()
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMsRaw) || toMsRaw <= fromMs) return []
  const maxDays = q.maxWindowDays ?? 62
  const toMs = Math.min(toMsRaw, fromMs + maxDays * DAY)

  const nowMs = q.now ? new Date(q.now).getTime() : Date.now()
  const floor = Math.max(fromMs, Number.isFinite(nowMs) ? nowMs : fromMs)

  const validBlocks = q.availability.filter(
    (b) =>
      Number.isInteger(b.day_of_week) &&
      b.day_of_week >= 0 &&
      b.day_of_week <= 6 &&
      HHMM_RE.test(b.start_time) &&
      HHMM_RE.test(b.end_time),
  )

  // ── working intervals: recurring availability per local day + extra-hours blocks
  const working: Interval[] = []
  // iterate local calendar days across the window (pad one day each side
  // so a block that straddles midnight-UTC is still captured)
  for (let cursor = fromMs - DAY; cursor <= toMs + DAY; cursor += DAY) {
    const dateKey = dateKeyInTz(cursor, q.timezone)
    const wd = weekdayOfDateKey(dateKey)
    for (const b of validBlocks) {
      if (b.day_of_week !== wd) continue
      const [sh, sm] = b.start_time.split(':').map(Number)
      const [eh, em] = b.end_time.split(':').map(Number)
      const start = zonedWallToUtc(dateKey, sh, sm, q.timezone)
      const end = zonedWallToUtc(dateKey, eh, em, q.timezone)
      if (end > start) working.push({ start, end })
    }
  }
  for (const t of q.timeOff ?? []) {
    if (!t.is_extra_hours) continue
    const s = new Date(t.starts_at).getTime()
    const e = new Date(t.ends_at).getTime()
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) working.push({ start: s, end: e })
  }

  // ── blocked intervals: non-extra time off + existing appointments
  const blocked: Interval[] = []
  for (const t of q.timeOff ?? []) {
    if (t.is_extra_hours) continue
    const s = new Date(t.starts_at).getTime()
    const e = new Date(t.ends_at).getTime()
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) blocked.push({ start: s, end: e })
  }
  for (const b of q.busy ?? []) {
    const s = new Date(b.start).getTime()
    const e = new Date(b.end).getTime()
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) blocked.push({ start: s, end: e })
  }

  const free = subtractIntervals(working, blocked)

  const slots: FreeSlot[] = []
  const durMs = duration * MIN
  const stepMs = step * MIN
  for (const iv of free) {
    // align the first candidate to the step grid measured from the interval start
    for (let t = iv.start; t + durMs <= iv.end; t += stepMs) {
      if (t < floor) continue
      if (t >= toMs) break
      slots.push({ start: new Date(t).toISOString(), end: new Date(t + durMs).toISOString() })
      if (slots.length >= MAX_SLOT_RESULTS) return slots
    }
  }
  // free intervals are already sorted & disjoint, so slots are sorted; dedupe defensively
  const seen = new Set<string>()
  return slots.filter((s) => (seen.has(s.start) ? false : (seen.add(s.start), true)))
}

/** Does `[start,end)` collide with any interval in `busy`? Used by the
 *  appointment create/reschedule path for its final conflict check. */
export function overlapsBusy(start: string, end: string, busy: BusyInterval[]): boolean {
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return false
  return busy.some((b) => {
    const bs = new Date(b.start).getTime()
    const be = new Date(b.end).getTime()
    return Number.isFinite(bs) && Number.isFinite(be) && s < be && bs < e
  })
}
