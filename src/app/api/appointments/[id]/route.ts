import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import {
  isAppointmentStatus,
  isConfirmationStatus,
} from '@/lib/clinic/appointment-status'
import { transitionAppointment } from '@/lib/clinic/appointments'

/**
 * PATCH /api/appointments/[id]
 *
 * Either a status transition ({ status, confirmation_status?, reason? })
 * or an inline edit of { amount, notes }. Reschedule has its own route
 * so the previous date is always recorded in history.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await params
    const b = await request.json().catch(() => null)
    if (!b || typeof b !== 'object') {
      return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 })
    }

    if ('status' in b) {
      if (!isAppointmentStatus(b.status)) {
        return NextResponse.json({ error: 'Estado inválido' }, { status: 400 })
      }
      const confirmation =
        b.confirmation_status != null && isConfirmationStatus(b.confirmation_status)
          ? b.confirmation_status
          : undefined
      const result = await transitionAppointment(supabase, accountId, userId, id, b.status, {
        confirmation_status: confirmation,
        reason: typeof b.reason === 'string' ? b.reason.slice(0, 300) : null,
      })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
      return NextResponse.json({ appointment: result.appointment })
    }

    // inline field edit
    const patch: Record<string, unknown> = { updated_by: userId }
    if ('amount' in b) {
      if (b.amount === null || b.amount === '') patch.amount = null
      else {
        const n = Number(b.amount)
        if (!Number.isFinite(n) || n < 0 || n > 9_999_999_999.99) {
          return NextResponse.json({ error: 'Monto inválido' }, { status: 400 })
        }
        patch.amount = n
      }
    }
    if ('notes' in b) {
      patch.notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 2000) : null
    }
    if (Object.keys(patch).length === 1) {
      return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('appointments')
      .update(patch)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) throw error
    if (!data) return NextResponse.json({ error: 'Cita no encontrada' }, { status: 404 })
    return NextResponse.json({ appointment: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/appointments/[id] — admin only (RLS also enforces). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('appointments')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
