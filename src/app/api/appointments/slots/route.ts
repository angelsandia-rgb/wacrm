import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getFreeSlots } from '@/lib/clinic/appointments'

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
    if (!doctorId || !from || !to) {
      return NextResponse.json({ error: 'doctor_id, from y to son obligatorios' }, { status: 400 })
    }
    const serviceId = url.searchParams.get('service_id')
    const durationParam = Number(url.searchParams.get('duration'))

    let duration = Number.isFinite(durationParam) && durationParam > 0 ? Math.round(durationParam) : 0
    if (!duration && serviceId) {
      const { data } = await supabase
        .from('products')
        .select('duration_minutes')
        .eq('account_id', accountId)
        .eq('id', serviceId)
        .maybeSingle()
      const d = Number(data?.duration_minutes)
      if (Number.isFinite(d) && d > 0) duration = Math.round(d)
    }
    if (!duration) duration = 30

    const { data: acct } = await supabase
      .from('accounts')
      .select('timezone')
      .eq('id', accountId)
      .maybeSingle()

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
