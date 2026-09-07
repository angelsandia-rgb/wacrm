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
  check_in: string | null // YYYY-MM-DD (habitaciones / paquetes)
  check_out: string | null // YYYY-MM-DD (habitaciones / paquetes)
  /** The "fecha de utilización" for spa / actividades / eventos —
   *  their equivalent of check_in. */
  use_date: string | null // YYYY-MM-DD
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
  // --- room revenue-management (category "habitaciones" only) ---
  /** Room-nights sold in the window (approved room reservations). */
  roomNights: number
  /** rooms × days in the window; `null` when the room count is unknown. */
  availableRoomNights: number | null
  /** roomNights / availableRoomNights, 0–1; `null` without a room count. */
  occupancy: number | null
  /** Estimated confirmed ROOM revenue attributable to the window. */
  revenue: number
  /** revenue / roomNights (average daily rate); `null` with no nights. */
  adr: number | null
  /** revenue / availableRoomNights; `null` without a room count. */
  revpar: number | null

  // --- demand, ALL categories (habitaciones + spa + actividades +
  //     paquetes + eventos), by request-creation date ---
  /** Reservation/service requests CREATED in the window, every category. */
  requests: number
  requestsPending: number
  requestsApproved: number
  requestsDenied: number
  /** approved / (approved + denied) among requests created in the window,
   *  every category. */
  approvalRate: number | null
  /** Sum of `estimated_price` across approved requests created in the
   *  window, every category — a rough "confirmed demand value". */
  estRevenue: number
  /** Average nights per approved stay (habitaciones + paquetes) created
   *  in the window. */
  avgLengthOfStay: number | null
  /** Average days from request to the service date (check-in, or the
   *  use date for spa/activities/events) — approved, created in window,
   *  every category. */
  avgLeadTimeDays: number | null
  /** Total guests across approved reservations whose service date
   *  (check-in or use date) falls in the window, every category. */
  guests: number
}

export function computeHotelKpis(
  reservations: HotelReservation[],
  roomCount: number | null,
  window: DateWindow,
): HotelKpis {
  // --- room revenue-management: category "habitaciones" only ---
  const rooms = reservations.filter((r) => r.category === 'habitaciones')
  const approvedRooms = rooms.filter((r) => r.status === 'approved')

  let roomNights = 0
  let revenue = 0
  for (const r of approvedRooms) {
    roomNights += nightsInWindow(r.check_in, r.check_out, window)
    revenue += windowRevenue(r, window)
  }

  const days = windowDays(window)
  const availableRoomNights = roomCount && roomCount > 0 ? roomCount * days : null
  const occupancy =
    availableRoomNights && availableRoomNights > 0
      ? Math.min(1, roomNights / availableRoomNights)
      : null

  // --- demand: EVERY category, by request-creation date ---
  const createdInWindow = reservations.filter((r) => inWindow(r.created_at, window))
  const cwApproved = createdInWindow.filter((r) => r.status === 'approved')
  const cwDenied = createdInWindow.filter((r) => r.status === 'denied')
  const decided = cwApproved.length + cwDenied.length

  // Length of stay only means something for the two categories that
  // have a check-in/check-out span.
  const stayCats = new Set(['habitaciones', 'paquetes'])
  const losValues = cwApproved
    .filter((r) => stayCats.has(r.category))
    .map((r) => stayNights(r.check_in, r.check_out))
    .filter((n) => n > 0)

  // Lead time: request → service date. Rooms/packages use check-in; spa,
  // activities and events use their `use_date`.
  const leadValues = cwApproved
    .map((r) => {
      const serviceYmd = r.check_in ?? r.use_date
      const svc = serviceYmd ? toUTCDate(serviceYmd) : null
      const cr = Date.parse(r.created_at)
      if (svc == null || Number.isNaN(cr)) return null
      const d = (svc - Date.parse(`${localYmd(new Date(cr))}T00:00:00Z`)) / DAY_MS
      return d >= 0 ? d : null
    })
    .filter((d): d is number => d != null)

  const estRevenue = cwApproved.reduce(
    (s, r) =>
      s + (typeof r.estimated_price === 'number' && r.estimated_price > 0 ? r.estimated_price : 0),
    0,
  )

  // Guests: approved reservations of any category whose service date
  // (check-in or use date) lands in the window — forward-looking, so
  // not limited to requests created in the window.
  const guests = reservations
    .filter((r) => {
      if (r.status !== 'approved') return false
      const d = r.check_in ?? r.use_date
      return d ? inWindow(`${d}T00:00:00Z`, window) : false
    })
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
    estRevenue,
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
 *  room revenue that day (category "habitaciones"), and reservation
 *  requests created that day (EVERY category). */
export function hotelDaySeries(
  reservations: HotelReservation[],
  window: DateWindow,
): DaySeriesPoint[] {
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

  for (const r of reservations) {
    if (r.category === 'habitaciones' && r.status === 'approved') {
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

export const CATEGORY_ORDER = ['habitaciones', 'spa', 'actividades', 'paquetes', 'eventos'] as const

export interface CategoryStat {
  category: string
  /** Requests created in the window. */
  requests: number
  pending: number
  approved: number
  denied: number
  /** approved / (approved + denied); `null` when nothing decided. */
  approvalRate: number | null
  /** Sum of `estimated_price` across this category's approved requests. */
  estRevenue: number
  /** Sum of `guests` across this category's approved requests. */
  guests: number
}

/**
 * Per-category demand stats for requests CREATED in the window. Always
 * returns the five known categories in order — even at zero — so every
 * service the hotel offers shows a row on the Panel / KPIs breakdown;
 * an unknown category is folded into 'otros', included only when it has
 * at least one request.
 */
export function hotelCategoryBreakdown(
  reservations: HotelReservation[],
  window: DateWindow,
): CategoryStat[] {
  const blank = (category: string): CategoryStat => ({
    category,
    requests: 0,
    pending: 0,
    approved: 0,
    denied: 0,
    approvalRate: null,
    estRevenue: 0,
    guests: 0,
  })
  const by = new Map<string, CategoryStat>(CATEGORY_ORDER.map((c) => [c, blank(c)]))

  for (const r of reservations) {
    if (!inWindow(r.created_at, window)) continue
    const key = (CATEGORY_ORDER as readonly string[]).includes(r.category) ? r.category : 'otros'
    const p = by.get(key) ?? blank(key)
    p.requests += 1
    if (r.status === 'pending') p.pending += 1
    else if (r.status === 'approved') p.approved += 1
    else if (r.status === 'denied') p.denied += 1
    if (r.status === 'approved') {
      if (typeof r.estimated_price === 'number' && r.estimated_price > 0) {
        p.estRevenue += r.estimated_price
      }
      if (typeof r.guests === 'number' && r.guests > 0) p.guests += r.guests
    }
    by.set(key, p)
  }

  for (const p of by.values()) {
    const d = p.approved + p.denied
    p.approvalRate = d > 0 ? p.approved / d : null
  }

  const otros = by.get('otros')
  return [
    ...CATEGORY_ORDER.map((c) => by.get(c)!),
    ...(otros && otros.requests > 0 ? [otros] : []),
  ]
}

export interface ArrivalsDepartures {
  /** Approved room check-ins in the next `days` days. */
  arrivals: number
  /** Approved room check-outs in the next `days` days. */
  departures: number
  arrivalGuests: number
  /** Approved spa / activity / event bookings whose use date is in the
   *  next `days` days. */
  services: number
}

/** Approved reservations checking in / out (rooms) or being used
 *  (spa / activities / events) within the next `days` days. */
export function upcomingArrivalsDepartures(
  reservations: HotelReservation[],
  fromDay: Date,
  days = 7,
): ArrivalsDepartures {
  const start = Date.parse(`${localYmd(fromDay)}T00:00:00Z`)
  const end = start + days * DAY_MS
  const inRange = (t: number | null) => t != null && t >= start && t < end
  let arrivals = 0
  let departures = 0
  let arrivalGuests = 0
  let services = 0
  for (const r of reservations) {
    if (r.status !== 'approved') continue
    if (r.category === 'habitaciones') {
      const ci = r.check_in ? toUTCDate(r.check_in) : null
      const co = r.check_out ? toUTCDate(r.check_out) : null
      if (inRange(ci)) {
        arrivals += 1
        arrivalGuests += typeof r.guests === 'number' ? r.guests : 0
      }
      if (inRange(co)) departures += 1
    } else if (r.category === 'spa' || r.category === 'actividades' || r.category === 'eventos') {
      const ud = r.use_date ? toUTCDate(r.use_date) : null
      if (inRange(ud)) services += 1
    }
  }
  return { arrivals, departures, arrivalGuests, services }
}
