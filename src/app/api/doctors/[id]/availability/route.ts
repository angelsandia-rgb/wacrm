import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseAvailabilityBlocks } from '@/lib/clinic/doctors'

/**
 * PUT /api/doctors/[id]/availability  { blocks: [{ day_of_week, start_time, end_time }] }
 *
 * Full replace — the schedule editor always sends the complete weekly
 * grid. Admin only. Deletes the doctor's existing blocks and inserts
 * the new set in one go (best-effort atomic: delete then insert; on an
 * insert failure the caller re-submits).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const body = await request.json().catch(() => null)
    const parsed = parseAvailabilityBlocks(body?.blocks)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data: doctor } = await supabase
      .from('doctor_profiles')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!doctor) return NextResponse.json({ error: 'Doctor no encontrado' }, { status: 404 })

    const { error: delErr } = await supabase
      .from('doctor_availability')
      .delete()
      .eq('account_id', accountId)
      .eq('doctor_id', id)
    if (delErr) throw delErr

    if (parsed.value.length > 0) {
      const { error: insErr } = await supabase.from('doctor_availability').insert(
        parsed.value.map((b) => ({
          account_id: accountId,
          doctor_id: id,
          day_of_week: b.day_of_week,
          start_time: b.start_time,
          end_time: b.end_time,
        })),
      )
      if (insErr) throw insErr
    }

    const { data } = await supabase
      .from('doctor_availability')
      .select('*')
      .eq('account_id', accountId)
      .eq('doctor_id', id)
      .order('day_of_week', { ascending: true })
      .order('start_time', { ascending: true })
    return NextResponse.json({ availability: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
