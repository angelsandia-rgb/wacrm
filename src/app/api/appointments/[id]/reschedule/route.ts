import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import { rescheduleAppointment } from '@/lib/clinic/appointments'

/**
 * POST /api/appointments/[id]/reschedule
 * { scheduled_at, duration_minutes?, reason? }
 *
 * Moves the appointment, records the previous date in
 * `appointment_history`, and resets status to SCHEDULED with a fresh
 * confirmation cycle.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await params
    const b = await request.json().catch(() => null)
    const result = await rescheduleAppointment(supabase, accountId, userId, id, {
      scheduled_at: typeof b?.scheduled_at === 'string' ? b.scheduled_at : '',
      duration_minutes: b?.duration_minutes != null ? Number(b.duration_minutes) : null,
      reason: typeof b?.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 300) : null,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ appointment: result.appointment })
  } catch (err) {
    return toErrorResponse(err)
  }
}
