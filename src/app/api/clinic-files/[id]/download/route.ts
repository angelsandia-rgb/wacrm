import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'

/**
 * GET /api/clinic-files/[id]/download
 * Returns `{ url }` — a short-lived signed URL for the private
 * `clinic-files` object. RLS scopes the row lookup + the storage
 * signing to the caller's account.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id } = await params

    const { data: file, error: fileError } = await supabase
      .from('clinic_files')
      .select('storage_path, filename')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (fileError) throw fileError
    if (!file) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 })

    const { data, error } = await supabase.storage
      .from('clinic-files')
      .createSignedUrl(file.storage_path as string, 120, { download: file.filename as string })
    if (error || !data?.signedUrl) {
      return NextResponse.json({ error: 'No se pudo generar el enlace' }, { status: 502 })
    }
    return NextResponse.json({ url: data.signedUrl })
  } catch (err) {
    return toErrorResponse(err)
  }
}
