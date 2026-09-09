import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createVisit } from '@/lib/clinic/visits'

/**
 * POST /api/visits
 * { patient_id, appointment_id?, doctor_id?, service_id?, visit_date,
 *   amount?, notes?, observations?, follow_up_date? }
 *
 * Registers a completed consultation. If tied to an appointment, the
 * appointment is marked COMPLETED.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const b = await request.json().catch(() => null)
    if (!b || typeof b !== 'object') {
      return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 })
    }
    const result = await createVisit(supabase, accountId, userId, {
      patient_id: typeof b.patient_id === 'string' ? b.patient_id : '',
      appointment_id: typeof b.appointment_id === 'string' && b.appointment_id ? b.appointment_id : null,
      doctor_id: typeof b.doctor_id === 'string' && b.doctor_id ? b.doctor_id : null,
      service_id: typeof b.service_id === 'string' && b.service_id ? b.service_id : null,
      visit_date: typeof b.visit_date === 'string' ? b.visit_date : '',
      amount: b.amount,
      notes: b.notes,
      observations: b.observations,
      follow_up_date: b.follow_up_date,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ visit: result.visit }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
