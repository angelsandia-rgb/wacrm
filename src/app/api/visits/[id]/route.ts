import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { updateVisit } from '@/lib/clinic/visits'

/**
 * PATCH /api/visits/[id]
 * { amount?, notes?, observations?, follow_up_date?, visit_date?, doctor_id?, service_id? }
 *
 * A change to notes / observations snapshots the previous text into
 * `visit_note_revisions` before the update.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await params
    const b = await request.json().catch(() => null)
    if (!b || typeof b !== 'object') {
      return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 })
    }
    const result = await updateVisit(supabase, accountId, userId, id, b)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ visit: result.visit })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/visits/[id] — admin only. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase.from('visits').delete().eq('account_id', accountId).eq('id', id)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
