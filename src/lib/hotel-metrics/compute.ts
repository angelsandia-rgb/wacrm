// ============================================================
// Hotel operating metrics — pure, no I/O, fully unit-tested.
//
// Computed from `reservation_requests` (the reservation ledger the
// AI / catalog / quote builder feed) + the room count. We don't have a
// folio / payments table, so "revenue" is the reservations' own
// `estimated_price` and everything is an ESTIMATE — but the formulas
// are the industry-standard ones (occupancy, ADR, RevPAR, length of
// stay, booking lead time), so the numbers move the way a hotelier
// expects.
// ============================================================

export type ReservationStatus = 'pending' | 'approved' | 'denied'

export interface HotelReservation {
  check_in: string | null // YYYY-MM-DD
  check_out: string | null // YYYY-MM-DD
  guests: number | null
  estimated_price: number | null
  status: ReservationStatus
  created_at: string // ISO
  category: string // habitaciones | spa | actividades | paquetes | eventos
}

export interface DateWindow {
  /** Inclusive local-day start. */
  start: Date
  /** Exclusive local-day end (start of the day after the last day). */
  end: Date
}

const DAY_MS = 86_400_000

function toUTCDate(ymd: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const t = Date.parse(`${ymd}T00:00:00Z`)
  return Number.isNaN(t) ? null : t
}

/** Whole nights of a stay (check-out exclusive). 0 for a bad/empty range. */
export function stayNights(checkIn: string | null, checkOut: string | null): number {
  if (!checkIn || !checkOut) return 0
  const a = toUTCDate(checkIn)
  const b = toUTCDate(checkOut)
  if (a == null || b == null || b <= a) return 0
  return Math.round((b - a) / DAY_MS)
}

/** How many of a stay's nights fall inside `[window.start, window.end)`. */
export function nightsInWindow(
  checkIn: string | null,
  checkOut: string | null,
  window: DateWindow,
): number {
  if (!checkIn || !checkOut) return 0
  const a = toUTCDate(checkIn)
  const b = toUTCDate(checkOut)
  if (a == null || b == null || b <= a) return 0
  // Compare on UTC-midnight day boundaries: the window's local days map
  // to the same YYYY-MM-DD the reservation dates use.
  const ws = Date.parse(`${localYmd(window.start)}T00:00:00Z`)
  const we = Date.parse(`${localYmd(window.end)}T00:00:00Z`)
  const from = Math.max(a, ws)
  const to = Math.min(b, we)
  return to <= from ? 0 : Math.round((to - from) / DAY_MS)
}

/** `YYYY-MM-DD` for a local Date. */
export function localYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Whole local days in the window (>= 0). */
export function windowDays(window: DateWindow): number {
  const ws = Date.parse(`${localYmd(window.start)}T00:00:00Z`)
  const we = Date.parse(`${localYmd(window.end)}T00:00:00Z`)
  return we <= ws ? 0 : Math.round((we - ws) / DAY_MS)
}

function inWindow(iso: string, window: DateWindow): boolean {
  const t = Date.parse(iso)
  return !Number.isNaN(t) && t >= window.start.getTime() && t < window.end.getTime()
}

/** A reservation's revenue attributable to the window — its
 *  `estimated_price` prorated by the share of its nights inside it. */
function windowRevenue(r: HotelReservation, window: DateWindow): number {
  const price = typeof r.estimated_price === 'number' ? r.estimated_price : 0
  if (price <= 0) return 0
  const total = stayNights(r.check_in, r.check_out)
  if (total <= 0) return 0
  return (price * nightsInWindow(r.check_in, r.check_out, window)) / total
}

export interface HotelKpis {
  /** Room-nights sold in the window (approved reservations). */
  roomNights: number
  /** rooms × days in the window; `null` when the room count is unknown. */
  availableRoomNights: number | null
  /** roomNights / availableRoomNights, 0–1; `null` without a room count. */
  occupancy: number | null
  /** Estimated confirmed revenue attributable to the window. */
  revenue: number
  /** revenue / roomNights (average daily rate); `null` with no nights. */
  adr: number | null
  /** revenue / availableRoomNights; `null` without a room count. */
  revpar: number | null
  /** Reservation requests CREATED in the window. */
  requests: number
  requestsPending: number
  requestsApproved: number
  requestsDenied: number
  /** approved / (approved + denied) among requests created in the window. */
  approvalRate: number | null
  /** Average total nights per approved reservation created in the window. */
  avgLengthOfStay: number | null
  /** Average days between request and check-in, approved, created in window. */
  avgLeadTimeDays: number | null
  /** Total guests across approved reservations whose check-in is in the window. */
  guests: number
}

export function computeHotelKpis(
  reservations: HotelReservation[],
  roomCount: number | null,
  window: DateWindow,
): HotelKpis {
  const rooms = reservations.filter((r) => r.category === 'habitaciones')
  const approved = rooms.filter((r) => r.status === 'approved')

  let roomNights = 0
  let revenue = 0
  for (const r of approved) {
    roomNights += nightsInWindow(r.check_in, r.check_out, window)
    revenue += windowRevenue(r, window)
  }

  const days = windowDays(window)
  const availableRoomNights = roomCount && roomCount > 0 ? roomCount * days : null
  const occupancy =
    availableRoomNights && availableRoomNights > 0
      ? Math.min(1, roomNights / availableRoomNights)
      : null

  const createdInWindow = rooms.filter((r) => inWindow(r.created_at, window))
  const cwApproved = createdInWindow.filter((r) => r.status === 'approved')
  const cwDenied = createdInWindow.filter((r) => r.status === 'denied')
  const decided = cwApproved.length + cwDenied.length

  const losValues = cwApproved
    .map((r) => stayNights(r.check_in, r.check_out))
    .filter((n) => n > 0)
  const leadValues = cwApproved
    .map((r) => {
      const ci = r.check_in ? toUTCDate(r.check_in) : null
      const cr = Date.parse(r.created_at)
      if (ci == null || Number.isNaN(cr)) return null
      const d = (ci - Date.parse(`${localYmd(new Date(cr))}T00:00:00Z`)) / DAY_MS
      return d >= 0 ? d : null
    })
    .filter((d): d is number => d != null)

  const guests = approved
    .filter((r) => r.check_in && inWindow(`${r.check_in}T00:00:00Z`, window))
    .reduce((s, r) => s + (typeof r.guests === 'number' ? r.guests : 0), 0)

  return {
    roomNights,
    availableRoomNights,
    occupancy,
    revenue,
    adr: roomNights > 0 ? revenue / roomNights : null,
    revpar:
      availableRoomNights && availableRoomNights > 0 ? revenue / availableRoomNights : null,
    requests: createdInWindow.length,
    requestsPending: createdInWindow.filter((r) => r.status === 'pending').length,
    requestsApproved: cwApproved.length,
    requestsDenied: cwDenied.length,
    approvalRate: decided > 0 ? cwApproved.length / decided : null,
    avgLengthOfStay: losValues.length
      ? losValues.reduce((a, b) => a + b, 0) / losValues.length
      : null,
    avgLeadTimeDays: leadValues.length
      ? leadValues.reduce((a, b) => a + b, 0) / leadValues.length
      : null,
    guests,
  }
}

export interface DaySeriesPoint {
  day: string // YYYY-MM-DD
  roomNights: number
  revenue: number
  requests: number
}

/** Per-day series across the window: confirmed room-nights + prorated
 *  revenue that day, and reservation requests created that day. */
export function hotelDaySeries(
  reservations: HotelReservation[],
  window: DateWindow,
): DaySeriesPoint[] {
  const rooms = reservations.filter((r) => r.category === 'habitaciones')
  const days: string[] = []
  const cursor = new Date(window.start)
  const totalDays = windowDays(window)
  for (let i = 0; i < totalDays && i < 400; i += 1) {
    days.push(localYmd(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  const byDay = new Map<string, DaySeriesPoint>(
    days.map((d) => [d, { day: d, roomNights: 0, revenue: 0, requests: 0 }]),
  )

  for (const r of rooms) {
    if (r.status === 'approved') {
      const total = stayNights(r.check_in, r.check_out)
      const perNight =
        total > 0 && typeof r.estimated_price === 'number' && r.estimated_price > 0
          ? r.estimated_price / total
          : 0
      const a = r.check_in ? toUTCDate(r.check_in) : null
      const b = r.check_out ? toUTCDate(r.check_out) : null
      if (a != null && b != null && b > a) {
        for (let t = a; t < b; t += DAY_MS) {
          const key = new Date(t).toISOString().slice(0, 10)
          const bucket = byDay.get(key)
          if (bucket) {
            bucket.roomNights += 1
            bucket.revenue += perNight
          }
        }
      }
    }
    const created = new Date(r.created_at)
    if (!Number.isNaN(created.getTime())) {
      const bucket = byDay.get(localYmd(created))
      if (bucket) bucket.requests += 1
    }
  }

  return days.map((d) => byDay.get(d)!)
}

export interface CategoryMixPoint {
  category: string
  requests: number
  revenue: number
}

const CATEGORY_ORDER = ['habitaciones', 'spa', 'actividades', 'paquetes', 'eventos']

/** Requests + estimated revenue by category, created in the window. */
export function hotelCategoryMix(
  reservations: HotelReservation[],
  window: DateWindow,
): CategoryMixPoint[] {
  const by = new Map<string, CategoryMixPoint>()
  for (const r of reservations) {
    if (!inWindow(r.created_at, window)) continue
    const key = CATEGORY_ORDER.includes(r.category) ? r.category : 'otros'
    const p = by.get(key) ?? { category: key, requests: 0, revenue: 0 }
    p.requests += 1
    if (typeof r.estimated_price === 'number' && r.estimated_price > 0) {
      p.revenue += r.estimated_price
    }
    by.set(key, p)
  }
  return [...CATEGORY_ORDER, 'otros']
    .map((c) => by.get(c))
    .filter((p): p is CategoryMixPoint => !!p && p.requests > 0)
}

export interface ArrivalsDepartures {
  arrivals: number
  departures: number
  arrivalGuests: number
}

/** Approved reservations checking in / out within the next `days` days. */
export function upcomingArrivalsDepartures(
  reservations: HotelReservation[],
  fromDay: Date,
  days = 7,
): ArrivalsDepartures {
  const start = Date.parse(`${localYmd(fromDay)}T00:00:00Z`)
  const end = start + days * DAY_MS
  let arrivals = 0
  let departures = 0
  let arrivalGuests = 0
  for (const r of reservations) {
    if (r.category !== 'habitaciones' || r.status !== 'approved') continue
    const ci = r.check_in ? toUTCDate(r.check_in) : null
    const co = r.check_out ? toUTCDate(r.check_out) : null
    if (ci != null && ci >= start && ci < end) {
      arrivals += 1
      arrivalGuests += typeof r.guests === 'number' ? r.guests : 0
    }
    if (co != null && co >= start && co < end) departures += 1
  }
  return { arrivals, departures, arrivalGuests }
}
