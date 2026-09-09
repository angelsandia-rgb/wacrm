import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { dateKeyInZone } from '@/lib/timezone'
import { isPatientSource } from '@/lib/clinic/types'
import { buildPatientAggregates } from '@/lib/clinic/patients'

/**
 * GET /api/patients/[id]
 *
 * The full patient profile: the `patient_profiles` row, its contact,
 * the derived header numbers, and the lists the profile tabs render
 * (visits newest-first, appointments). RLS-scoped; a restricted
 * doctor-user only sees the appointments / visits that are theirs.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id } = await params

    const { data: patient, error } = await supabase
      .from('patient_profiles')
      .select('*, contacts!inner(id, name, phone, email, avatar_url, created_at, lead_temperature)')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!patient) return NextResponse.json({ error: 'Paciente no encontrado' }, { status: 404 })

    const { data: acct } = await supabase
      .from('accounts')
      .select('timezone')
      .eq('id', accountId)
      .maybeSingle()
    const tz = (acct?.timezone as string | null) || 'UTC'
    const now = new Date()

    const [{ data: visits }, { data: appointments }] = await Promise.all([
      supabase
        .from('visits')
        .select('id, visit_date, amount, notes, observations, follow_up_date, doctor_id, service_id, appointment_id, created_at')
        .eq('account_id', accountId)
        .eq('patient_id', id)
        .order('visit_date', { ascending: false })
        .limit(200),
      supabase
        .from('appointments')
        .select('id, scheduled_at, ends_at, status, confirmation_status, amount, doctor_id, service_id, conversation_id')
        .eq('account_id', accountId)
        .eq('patient_id', id)
        .order('scheduled_at', { ascending: false })
        .limit(200),
    ])

    const aggMap = buildPatientAggregates(
      (visits ?? []).map((v) => ({
        patient_id: id,
        visit_date: v.visit_date as string | null,
        amount: v.amount as number | string | null,
        follow_up_date: v.follow_up_date as string | null,
      })),
      (appointments ?? []).map((a) => ({
        patient_id: id,
        scheduled_at: a.scheduled_at as string,
        status: a.status as string,
      })),
      now.toISOString(),
      dateKeyInZone(now, tz),
    )
    const aggregate =
      aggMap.get(id) ?? {
        last_visit_date: null,
        next_appointment_at: null,
        visit_count: 0,
        total_value: 0,
        follow_up_due: false,
      }

    return NextResponse.json({
      patient,
      aggregate,
      visits: visits ?? [],
      appointments: appointments ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/patients/[id]  { source? }
 *
 * Only the patient-profile scalar fields are editable here — the
 * person's name / phone / email live on the contact and are edited in
 * Contactos, not duplicated.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const body = await request.json().catch(() => null)

    const patch: Record<string, unknown> = {}
    if ('source' in (body ?? {})) {
      if (body.source === null || body.source === '') patch.source = null
      else if (isPatientSource(body.source)) patch.source = body.source
      else return NextResponse.json({ error: 'source no válido' }, { status: 400 })
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('patient_profiles')
      .update(patch)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) throw error
    if (!data) return NextResponse.json({ error: 'Paciente no encontrado' }, { status: 404 })
    return NextResponse.json({ patient: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
