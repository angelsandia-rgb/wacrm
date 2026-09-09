// ============================================================
// Clinic reminder sweep — pure helpers (windows + message text). The
// DB side lives in `reminders-sweep.ts`, driven by
// /api/clinic/reminders/cron.
// ============================================================

const HOUR = 3_600_000

/** Appointments whose confirmation reminder is due: roughly "tomorrow"
 *  — between 18h and 30h from now, so a ~5-min cron always catches the
 *  24h mark once. */
export function confirmationWindow(now: Date): { from: string; to: string } {
  return {
    from: new Date(now.getTime() + 18 * HOUR).toISOString(),
    to: new Date(now.getTime() + 30 * HOUR).toISOString(),
  }
}

/**
 * A confirmation is "no response" when the reminder went out at least
 * `graceHours` ago and the appointment is now imminent or already past
 * (there was time to reply and it didn't come).
 */
export function isNoResponseDue(args: {
  reminderSentAt: string | null
  scheduledAt: string
  now: Date
  graceHours?: number
}): boolean {
  if (!args.reminderSentAt) return false
  const grace = (args.graceHours ?? 12) * HOUR
  const sent = Date.parse(args.reminderSentAt)
  const sched = Date.parse(args.scheduledAt)
  if (!Number.isFinite(sent) || !Number.isFinite(sched)) return false
  return args.now.getTime() - sent >= grace && sched <= args.now.getTime() + 3 * HOUR
}

function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  if (!n) return ''
  return n.split(/\s+/)[0]
}

export function renderConfirmationMessage(args: {
  patientName: string | null
  timeLabel: string // e.g. "mañana a las 10:00 AM"
  doctorName: string | null
}): string {
  const hi = firstName(args.patientName) ? `Hola ${firstName(args.patientName)} 👋` : 'Hola 👋'
  const withDoc = args.doctorName ? ` con ${args.doctorName}` : ''
  return `${hi} Te recordamos tu cita ${args.timeLabel}${withDoc}. ¿Confirmas tu asistencia?`
}

export function renderFollowupMessage(args: {
  patientName: string | null
  doctorName: string | null
}): string {
  const hi = firstName(args.patientName) ? `Hola ${firstName(args.patientName)} 👋` : 'Hola 👋'
  const who = args.doctorName ? `${args.doctorName} recomendó` : 'Te recomendamos'
  return `${hi} ${who} realizar un seguimiento tras tu última visita. ¿Quieres que te muestre horarios disponibles?`
}

/**
 * "mañana a las 10:00 AM" / "hoy a las 3:30 PM" / "el vie 12 a las 9:00 AM"
 * for `whenISO` read in `tz`, relative to `now`.
 */
export function humanWhen(whenISO: string, tz: string, now: Date): string {
  const when = new Date(whenISO)
  const dayKey = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  // en-US for a clean "10:00 AM" (es-GT renders "a. m." with periods).
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(when)

  const today = dayKey(now)
  const tomorrow = dayKey(new Date(now.getTime() + 24 * HOUR))
  const wk = dayKey(when)
  if (wk === today) return `hoy a las ${time}`
  if (wk === tomorrow) return `mañana a las ${time}`
  const label = new Intl.DateTimeFormat('es-GT', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(
    when,
  )
  return `el ${label} a las ${time}`
}
