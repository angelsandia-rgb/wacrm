import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import {
  APPOINTMENT_MAX_DURATION_MINUTES,
  APPOINTMENT_MIN_DURATION_MINUTES,
  getFreeSlots,
} from '@/lib/clinic/appointments'

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const MAX_WINDOW_MS = 62 * 86_400_000

/**
 * GET /api/appointments/slots?doctor_id=&service_id=&from=&to=&duration=
 *
 * Bookable start times for a (doctor, service) in a window — recurring
 * availability minus time off minus the doctor's existing appointments.
 * `duration` (minutes) overrides the service's default; the window is
 * capped server-side.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const doctorId = url.searchParams.get('doctor_id') ?? ''
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    if (!UUID_RE.test(doctorId) || !from || !to) {
      return NextResponse.json({ error: 'doctor_id, from y to son obligatorios' }, { status: 400 })
    }
    const fromMs = Date.parse(from)
    const toMs = Date.parse(to)
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return NextResponse.json({ error: 'Rango de fechas inválido' }, { status: 400 })
    }
    if (toMs - fromMs > MAX_WINDOW_MS) {
      return NextResponse.json({ error: 'El rango máximo es de 62 días' }, { status: 400 })
    }
    const serviceId = url.searchParams.get('service_id')
    const durationParam = Number(url.searchParams.get('duration'))

    let duration = Number.isFinite(durationParam) && durationParam > 0 ? Math.round(durationParam) : 0
    if (
      duration &&
      (duration < APPOINTMENT_MIN_DURATION_MINUTES ||
        duration > APPOINTMENT_MAX_DURATION_MINUTES)
    ) {
      return NextResponse.json({ error: 'Duración fuera de rango' }, { status: 400 })
    }
    if (!duration && serviceId) {
      if (!UUID_RE.test(serviceId)) {
        return NextResponse.json({ error: 'service_id inválido' }, { status: 400 })
      }
      const { data, error } = await supabase
        .from('products')
        .select('duration_minutes')
        .eq('account_id', accountId)
        .eq('id', serviceId)
        .maybeSingle()
      if (error) throw error
      const d = Number(data?.duration_minutes)
      if (Number.isFinite(d) && d > 0) duration = Math.round(d)
    }
    if (!duration) duration = 30
    if (
      duration < APPOINTMENT_MIN_DURATION_MINUTES ||
      duration > APPOINTMENT_MAX_DURATION_MINUTES
    ) {
      return NextResponse.json({ error: 'La duración del servicio es inválida' }, { status: 400 })
    }

    const { data: acct, error: acctError } = await supabase
      .from('accounts')
      .select('timezone')
      .eq('id', accountId)
      .maybeSingle()
    if (acctError) throw acctError

    const slots = await getFreeSlots(supabase, accountId, {
      doctorId,
      from,
      to,
      durationMinutes: duration,
      timezone: (acct?.timezone as string | null) || 'UTC',
      nowISO: new Date().toISOString(),
    })
    return NextResponse.json({ slots, duration })
  } catch (err) {
    return toErrorResponse(err)
  }
}
