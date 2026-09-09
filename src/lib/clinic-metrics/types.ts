// ============================================================
// Clinic dashboard — the shape the backend computes and the panel
// renders. One backend call (`GET /api/clinic-dashboard?from=&to=`)
// returns all of it; the frontend does no business math.
// ============================================================

export interface RevenueStat {
  total: number
  previousPeriod: number
  /** null when the previous period had zero revenue. */
  percentageChange: number | null
}

export interface PatientSegmentStat {
  count: number
  revenue: number
}

export interface AppointmentsStat {
  total: number
  confirmed: number
  noShows: number
  /** confirmed / (appointments whose confirmation was required). null when none required. */
  confirmationRate: number | null
  /** no-shows / total. null when no appointments. */
  noShowRate: number | null
}

export interface ConversionsStat {
  conversations: number
  bookedAppointments: number
  completedVisits: number
  /** bookedAppointments / conversations. null when no conversations. */
  bookingConversionRate: number | null
  /** completedVisits / conversations. null when no conversations. */
  completedConversionRate: number | null
}

export interface HumanResponseStat {
  /** mean seconds from a customer inbound to the first human reply, over
   *  the window. null when there was no measurable pair. */
  averageSeconds: number | null
  /** how many (conversation) first-response pairs went into the mean. */
  sampleSize: number
}

export interface AttentionRequired {
  unconfirmedAppointments: number
  noShows: number
  followUps: number
  conversationsWaiting: number
}

export interface UpcomingAppointment {
  id: string
  scheduled_at: string
  patient_name: string | null
  doctor_name: string | null
  service_name: string | null
  status: string
  confirmation_status: string
}

export interface AppointmentsByDayPoint {
  /** yyyy-mm-dd (clinic local) */
  date: string
  scheduled: number
  confirmed: number
  completed: number
  noShows: number
}

export interface ClinicDashboardStats {
  range: { from: string; to: string }
  currency: string
  revenue: RevenueStat
  newPatients: PatientSegmentStat
  returningPatients: PatientSegmentStat
  appointments: AppointmentsStat
  conversions: ConversionsStat
  humanResponse: HumanResponseStat
  attentionRequired: AttentionRequired
  upcoming: UpcomingAppointment[]
  byDay: AppointmentsByDayPoint[]
}
