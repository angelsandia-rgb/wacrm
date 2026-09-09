import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/** GET /api/appointments/[id]/history — the append-only change log. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id } = await params
    const { data, error } = await supabase
      .from('appointment_history')
      .select('*')
      .eq('account_id', accountId)
      .eq('appointment_id', id)
      .order('created_at', { ascending: true })
    if (error) throw error
    return NextResponse.json({ history: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
