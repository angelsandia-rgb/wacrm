import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'

/** DELETE /api/clinic-files/[id] — removes the row and the storage object. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params

    const { data: file, error: fileError } = await supabase
      .from('clinic_files')
      .select('id, storage_path')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (fileError) throw fileError
    if (!file) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 })

    // Keep the metadata if Storage fails. Deleting the row first (or
    // ignoring this error) can orphan a private medical document that no
    // longer appears in the clinic UI and is much harder to remove later.
    const { error: storageError } = await supabase.storage
      .from('clinic-files')
      .remove([file.storage_path as string])
    if (storageError) {
      console.error('[clinic files] storage removal failed:', storageError)
      return NextResponse.json({ error: 'No se pudo eliminar el archivo' }, { status: 502 })
    }

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
