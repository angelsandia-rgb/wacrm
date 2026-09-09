import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import { parseDoctorInput } from '@/lib/clinic/doctors'

/** PATCH /api/doctors/[id] — admin only. Partial update. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const parsed = parseDoctorInput(await request.json().catch(() => null), true)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    if (Object.keys(parsed.value).length === 0) {
      return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 })
    }

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
      .update(parsed.value)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'Ese usuario ya está vinculado a un doctor' }, { status: 409 })
      }
      throw error
    }
    if (!data) return NextResponse.json({ error: 'Doctor no encontrado' }, { status: 404 })
    return NextResponse.json({ doctor: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/doctors/[id] — admin only. Refuses if the doctor has any
 * appointment (the `ON DELETE RESTRICT` FK would fail anyway); archive
 * instead (`PATCH { is_active: false }`).
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    const { count, error: countError } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('doctor_id', id)
    if (countError) throw countError
    if ((count ?? 0) > 0) {
      return NextResponse.json(
        { error: 'El doctor tiene citas registradas. Archívalo en vez de eliminarlo.' },
        { status: 409 },
      )
    }

    const { error } = await supabase
      .from('doctor_profiles')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
