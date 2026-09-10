import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'

/** GET /api/visits/[id]/revisions — the append-only note history. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id } = await params
    const { data, error } = await supabase
      .from('visit_note_revisions')
      .select('*')
      .eq('account_id', accountId)
      .eq('visit_id', id)
      .order('created_at', { ascending: false })
    if (error) throw error
    return NextResponse.json({ revisions: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
