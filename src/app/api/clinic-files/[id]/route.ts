import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/** DELETE /api/clinic-files/[id] — removes the row and the storage object. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params

    const { data: file } = await supabase
      .from('clinic_files')
      .select('id, storage_path')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!file) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 })

    // storage object first (RLS-scoped to the account folder); a miss is fine
    await supabase.storage.from('clinic-files').remove([file.storage_path as string])

    const { error } = await supabase
      .from('clinic_files')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
