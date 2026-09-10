import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import { parseAvailabilityBlocks } from '@/lib/clinic/doctors'

/**
 * PUT /api/doctors/[id]/availability  { blocks: [{ day_of_week, start_time, end_time }] }
 *
 * Full replace — the schedule editor always sends the complete weekly
 * grid. Admin only. The database RPC performs delete + insert in one
 * transaction, so a malformed row or transient error cannot erase the
 * doctor's previously valid schedule.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const body = await request.json().catch(() => null)
    const parsed = parseAvailabilityBlocks(body?.blocks)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data, error } = await supabase.rpc('replace_doctor_availability', {
      p_account_id: accountId,
      p_doctor_id: id,
      p_blocks: parsed.value,
    })
    if (error?.code === 'P0002') {
      return NextResponse.json({ error: 'Doctor no encontrado' }, { status: 404 })
    }
    if (error) throw error
    return NextResponse.json({ availability: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
