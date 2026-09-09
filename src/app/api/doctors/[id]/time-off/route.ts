import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import { parseTimeOff } from '@/lib/clinic/doctors'

/** POST /api/doctors/[id]/time-off  { starts_at, ends_at, reason?, is_extra_hours? } — admin. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const parsed = parseTimeOff(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data: doctor, error: doctorError } = await supabase
      .from('doctor_profiles')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (doctorError) throw doctorError
    if (!doctor) return NextResponse.json({ error: 'Doctor no encontrado' }, { status: 404 })

    const { data, error } = await supabase
      .from('doctor_time_off')
      .insert({ account_id: accountId, doctor_id: id, ...parsed.value })
      .select('*')
      .single()
    if (error) throw error
    return NextResponse.json({ timeOff: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/doctors/[id]/time-off?entry=<uuid> — admin. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const entry = new URL(request.url).searchParams.get('entry')
    if (!entry) return NextResponse.json({ error: 'entry es obligatorio' }, { status: 400 })

    const { error } = await supabase
      .from('doctor_time_off')
      .delete()
      .eq('account_id', accountId)
      .eq('doctor_id', id)
      .eq('id', entry)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
