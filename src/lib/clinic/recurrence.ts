// ============================================================
// "Repetir cita" (spec §8) — expand a first appointment into a series.
// Pure. Every instance the caller inserts shares one
// `recurrence_group_id`.
// ============================================================

import { type RecurrenceSpec } from './types'

const MIN = 60_000
export const RECURRENCE_MIN_COUNT = 2
export const RECURRENCE_MAX_COUNT = 26

export interface RecurrenceInstance {
  start: string // ISO
  end: string // ISO
}

/**
 * `count` instances (including the first), starting at `firstStartISO`,
 * each `durationMinutes` long.
 *
 *  - weekly    → +7 days
 *  - biweekly  → +14 days
 *  - monthly   → same day-of-month next month, clamped to the last day
 *               (Jan 31 → Feb 28/29), keeping the wall time.
 *
 * Returns `[]` for a bad spec or an unparseable start.
 */
export function expandRecurrence(
  firstStartISO: string,
  durationMinutes: number,
  spec: RecurrenceSpec,
): RecurrenceInstance[] {
  const first = new Date(firstStartISO)
  if (Number.isNaN(first.getTime())) return []
  const dur = Math.round(durationMinutes)
  if (!Number.isFinite(dur) || dur <= 0) return []
  const count = Math.round(spec.count)
  if (!Number.isFinite(count) || count < RECURRENCE_MIN_COUNT || count > RECURRENCE_MAX_COUNT) return []

  const out: RecurrenceInstance[] = []
  for (let i = 0; i < count; i += 1) {
    let start: Date
    if (spec.frequency === 'weekly') {
      start = new Date(first.getTime() + i * 7 * 24 * MIN * 60)
    } else if (spec.frequency === 'biweekly') {
      start = new Date(first.getTime() + i * 14 * 24 * MIN * 60)
    } else {
      // monthly — advance the month, clamp the day
      start = addMonthsClamped(first, i)
    }
    out.push({
      start: start.toISOString(),
      end: new Date(start.getTime() + dur * MIN).toISOString(),
    })
  }
  return out
}

/** `base` + `n` months, keeping the time-of-day, clamping the day to the
 *  target month's length (works off UTC fields — callers pass an
 *  offset-anchored instant). */
function addMonthsClamped(base: Date, n: number): Date {
  if (n === 0) return new Date(base.getTime())
  const y = base.getUTCFullYear()
  const m = base.getUTCMonth() + n
  const targetY = y + Math.floor(m / 12)
  const targetM = ((m % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate()
  const day = Math.min(base.getUTCDate(), lastDay)
  return new Date(
    Date.UTC(
      targetY,
      targetM,
      day,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds(),
    ),
  )
}
