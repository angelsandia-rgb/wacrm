import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isAppointmentStatus } from '@/lib/clinic/appointment-status'
import { isRecurrenceFrequency } from '@/lib/clinic/types'
import { createAppointment, listAppointments } from '@/lib/clinic/appointments'

/**
 * GET /api/appointments?from=&to=&doctor_id=&service_id=&status=&search=
 * Dates are ISO instants (the client computes named ranges in the
 * account's timezone). RLS-scoped; a restricted doctor-user only sees
 * their own.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const statusParam = url.searchParams.get('status')

    const rows = await listAppointments(supabase, accountId, {
      fromISO: url.searchParams.get('from') ?? undefined,
      toISO: url.searchParams.get('to') ?? undefined,
      doctorId: url.searchParams.get('doctor_id') ?? undefined,
      serviceId: url.searchParams.get('service_id') ?? undefined,
      status: statusParam && isAppointmentStatus(statusParam) ? statusParam : undefined,
      search: url.searchParams.get('search') ?? undefined,
    })
    return NextResponse.json({ appointments: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/appointments
 * { patient_id, doctor_id, service_id?, scheduled_at, duration_minutes?,
 *   amount?, notes?, needs_confirmation?, conversation_id?,
 *   recurrence?: { frequency, count } }
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const b = await request.json().catch(() => null)
    if (!b || typeof b !== 'object') {
      return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 })
    }

    let recurrence: { frequency: import('@/lib/clinic/types').RecurrenceFrequency; count: number } | null =
      null
    if (b.recurrence && typeof b.recurrence === 'object') {
      if (!isRecurrenceFrequency(b.recurrence.frequency)) {
        return NextResponse.json({ error: 'Frecuencia de repetición inválida' }, { status: 400 })
      }
      recurrence = { frequency: b.recurrence.frequency, count: Number(b.recurrence.count) }
    }

    const result = await createAppointment(supabase, accountId, userId, {
      patient_id: typeof b.patient_id === 'string' ? b.patient_id : '',
      doctor_id: typeof b.doctor_id === 'string' ? b.doctor_id : '',
      service_id: typeof b.service_id === 'string' && b.service_id ? b.service_id : null,
      conversation_id:
        typeof b.conversation_id === 'string' && b.conversation_id ? b.conversation_id : null,
      scheduled_at: typeof b.scheduled_at === 'string' ? b.scheduled_at : '',
      duration_minutes: b.duration_minutes != null ? Number(b.duration_minutes) : null,
      amount: b.amount != null && b.amount !== '' ? Number(b.amount) : null,
      notes: typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 2000) : null,
      needs_confirmation: b.needs_confirmation !== false,
      recurrence,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
