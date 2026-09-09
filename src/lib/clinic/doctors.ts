// ============================================================
// Doctors + their weekly availability / time off — validation and
// small pure helpers. No I/O. Used by the /api/doctors routes and the
// Settings → Clínica panel.
// ============================================================

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export interface AvailabilityBlockInput {
  day_of_week: number
  start_time: string // HH:MM
  end_time: string
}

export interface TimeOffInput {
  starts_at: string // ISO
  ends_at: string
  reason?: string | null
  is_extra_hours?: boolean
}

/** `HH:MM` → minutes since midnight, or `null` if malformed. */
export function hhmmToMinutes(v: string): number | null {
  const m = HHMM_RE.exec(v)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v)
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Validate the full set of weekly availability blocks for one doctor
 * (the editor always sends the complete list — a PUT/replace). Rejects
 * malformed times, `end <= start`, and overlapping blocks on the same
 * weekday. Normalises to `HH:MM` and sorts.
 */
export function parseAvailabilityBlocks(raw: unknown): ParseResult<AvailabilityBlockInput[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'blocks debe ser un arreglo' }
  if (raw.length > 60) return { ok: false, error: 'Demasiados bloques de horario' }

  const out: AvailabilityBlockInput[] = []
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: `blocks[${i}] inválido` }
    const e = entry as Record<string, unknown>
    const day = Number(e.day_of_week)
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return { ok: false, error: `blocks[${i}].day_of_week debe ser 0–6` }
    }
    const start = typeof e.start_time === 'string' ? e.start_time.slice(0, 5) : ''
    const end = typeof e.end_time === 'string' ? e.end_time.slice(0, 5) : ''
    const s = hhmmToMinutes(start)
    const en = hhmmToMinutes(end)
    if (s == null || en == null) return { ok: false, error: `blocks[${i}] hora inválida (HH:MM)` }
    if (en <= s) return { ok: false, error: `blocks[${i}] la hora de fin debe ser posterior al inicio` }
    out.push({ day_of_week: day, start_time: start, end_time: end })
  }

  out.sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time))
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1]
    const cur = out[i]
    if (
      prev.day_of_week === cur.day_of_week &&
      hhmmToMinutes(cur.start_time)! < hhmmToMinutes(prev.end_time)!
    ) {
      return { ok: false, error: 'Hay bloques de horario que se solapan el mismo día' }
    }
  }
  return { ok: true, value: out }
}

export function parseTimeOff(raw: unknown): ParseResult<Required<TimeOffInput>> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Cuerpo inválido' }
  const e = raw as Record<string, unknown>
  const start = typeof e.starts_at === 'string' ? new Date(e.starts_at) : null
  const end = typeof e.ends_at === 'string' ? new Date(e.ends_at) : null
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'Fechas inválidas' }
  }
  if (end.getTime() <= start.getTime()) {
    return { ok: false, error: 'La fecha de fin debe ser posterior al inicio' }
  }
  if (end.getTime() - start.getTime() > 366 * 86_400_000) {
    return { ok: false, error: 'El rango no puede exceder un año' }
  }
  const reason =
    typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim().slice(0, 300) : null
  return {
    ok: true,
    value: {
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      reason,
      is_extra_hours: e.is_extra_hours === true,
    },
  }
}

export interface DoctorInput {
  display_name: string
  specialty?: string | null
  color?: string | null
  is_active?: boolean
  user_id?: string | null
  restrict_to_own?: boolean
}

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** Validate the create/patch body for a doctor. `partial` = PATCH
 *  (only the supplied keys are validated / returned). */
export function parseDoctorInput(raw: unknown, partial: boolean): ParseResult<Partial<DoctorInput>> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Cuerpo inválido' }
  const e = raw as Record<string, unknown>
  const out: Partial<DoctorInput> = {}

  if (!partial || 'display_name' in e) {
    const name = typeof e.display_name === 'string' ? e.display_name.trim() : ''
    if (name.length < 2 || name.length > 120) {
      return { ok: false, error: 'El nombre del doctor debe tener 2–120 caracteres' }
    }
    out.display_name = name
  }
  if ('specialty' in e) {
    out.specialty =
      typeof e.specialty === 'string' && e.specialty.trim() ? e.specialty.trim().slice(0, 120) : null
  }
  if ('color' in e) {
    if (e.color == null || e.color === '') out.color = null
    else if (isHexColor(e.color)) out.color = e.color
    else return { ok: false, error: 'El color debe ser un hex #rrggbb' }
  }
  if ('is_active' in e) out.is_active = e.is_active !== false
  if ('restrict_to_own' in e) out.restrict_to_own = e.restrict_to_own !== false
  if ('user_id' in e) {
    if (e.user_id == null || e.user_id === '') out.user_id = null
    else if (typeof e.user_id === 'string' && UUID_RE.test(e.user_id)) out.user_id = e.user_id
    else return { ok: false, error: 'user_id inválido' }
  }

  if (!partial && !out.display_name) {
    return { ok: false, error: 'display_name es obligatorio' }
  }
  return { ok: true, value: out }
}

/** Mon-first day labels (ES) for the schedule editor. `day_of_week` is
 *  0=Sun..6=Sat; this maps display order Lun..Dom. */
export const DAY_LABELS_ES: { value: number; label: string }[] = [
  { value: 1, label: 'Lunes' },
  { value: 2, label: 'Martes' },
  { value: 3, label: 'Miércoles' },
  { value: 4, label: 'Jueves' },
  { value: 5, label: 'Viernes' },
  { value: 6, label: 'Sábado' },
  { value: 0, label: 'Domingo' },
]
