import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import { parseDoctorInput } from '@/lib/clinic/doctors'

/**
 * GET /api/doctors
 *
 * Every doctor of the account (active + archived) with their weekly
 * availability and upcoming time off, so the Settings → Clínica panel
 * renders in one round trip.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')

    const { data: doctors, error } = await supabase
      .from('doctor_profiles')
      .select('*')
      .eq('account_id', accountId)
      .order('is_active', { ascending: false })
      .order('display_name', { ascending: true })
    if (error) throw error

    const ids = (doctors ?? []).map((d) => d.id)
    let availability: unknown[] = []
    let timeOff: unknown[] = []
    if (ids.length > 0) {
      const [availabilityResult, timeOffResult] = await Promise.all([
        supabase
          .from('doctor_availability')
          .select('*')
          .eq('account_id', accountId)
          .in('doctor_id', ids),
        supabase
          .from('doctor_time_off')
          .select('*')
          .eq('account_id', accountId)
          .in('doctor_id', ids)
          .gte('ends_at', new Date().toISOString())
          .order('starts_at', { ascending: true }),
      ])
      if (availabilityResult.error) throw availabilityResult.error
      if (timeOffResult.error) throw timeOffResult.error
      availability = availabilityResult.data ?? []
      timeOff = timeOffResult.data ?? []
    }

    return NextResponse.json({ doctors: doctors ?? [], availability, timeOff })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/doctors  { display_name, specialty?, color?, user_id?, restrict_to_own? }
 * Admin only (managing the clinic roster is configuration).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const parsed = parseDoctorInput(await request.json().catch(() => null), false)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    // a linked user must be a member of this account
    if (parsed.value.user_id) {
      const { data: member, error: memberError } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', parsed.value.user_id)
        .maybeSingle()
      if (memberError) throw memberError
      if (!member) {
        return NextResponse.json({ error: 'El usuario no pertenece a esta cuenta' }, { status: 400 })
      }
    }

    const { data, error } = await supabase
      .from('doctor_profiles')
      .insert({ account_id: accountId, ...parsed.value })
      .select('*')
      .single()
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'Ese usuario ya está vinculado a un doctor' }, { status: 409 })
      }
      throw error
    }
    return NextResponse.json({ doctor: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
