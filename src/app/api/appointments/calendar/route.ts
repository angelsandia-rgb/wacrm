import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import { listAppointments } from '@/lib/clinic/appointments'
import type { CalendarEvent, CalendarEventsResponse } from '@/lib/google-calendar/types'

const MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1000

/**
 * GET /api/appointments/calendar?start=<ISO>&end=<ISO>
 *
 * The clinic calendar's data source — the account's own `appointments`
 * shaped like `CalendarEvent[]` so the existing month / week / agenda
 * grids render them unchanged. Cancelled / declined appointments are
 * dropped. Same `CalendarEventsResponse` envelope as the Google
 * Calendar route (`connected` is always true here).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { searchParams } = new URL(request.url)
    const now = Date.now()
    const start = searchParams.get('start') ? new Date(searchParams.get('start')!) : new Date(now)
    let end = searchParams.get('end')
      ? new Date(searchParams.get('end')!)
      : new Date(now + 31 * 24 * 60 * 60 * 1000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return NextResponse.json({ error: 'Invalid start/end range' }, { status: 400 })
    }
    if (end.getTime() - start.getTime() > MAX_RANGE_MS) {
      end = new Date(start.getTime() + MAX_RANGE_MS)
    }

    const rows = await listAppointments(supabase, accountId, {
      fromISO: start.toISOString(),
      toISO: end.toISOString(),
      limit: 1000,
    })

    const events: CalendarEvent[] = rows
      .filter((r) => r.status !== 'CANCELLED' && r.status !== 'DECLINED')
      .map((r) => {
        const rr = r as Record<string, unknown>
        const contacts = (rr.patient_profiles as { id?: string; contacts?: { name?: string | null } } | null) ?? null
        const doctor = (rr.doctor_profiles as { display_name?: string; color?: string | null } | null) ?? null
        const service = (rr.products as { name?: string } | null) ?? null
        const patientName = contacts?.contacts?.name ?? null
        return {
          id: rr.id as string,
          summary: patientName || 'Paciente',
          description: [doctor?.display_name, service?.name].filter(Boolean).join(' · ') || null,
          location: null,
          start: rr.scheduled_at as string,
          end: rr.ends_at as string,
          allDay: false,
          status: 'confirmed',
          htmlLink: null,
          meetLink: null,
          attendees: [],
          organizerEmail: null,
          clinic: {
            appointmentId: rr.id as string,
            patientId: rr.patient_id as string,
            patientName,
            doctorName: doctor?.display_name ?? null,
            doctorColor: doctor?.color ?? null,
            serviceName: service?.name ?? null,
            apptStatus: r.status,
            confirmationStatus: r.confirmation_status,
          },
        }
      })

    const body: CalendarEventsResponse = { connected: true, events }
    return NextResponse.json(body)
  } catch (err) {
    return toErrorResponse(err)
  }
}
