import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/**
 * GET /api/clinic-files?patient_id=&visit_id=
 * File metadata for a patient or a visit. The bucket is private —
 * downloads go through GET /api/clinic-files/[id]/download.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const patientId = url.searchParams.get('patient_id')
    const visitId = url.searchParams.get('visit_id')
    if (!patientId && !visitId) {
      return NextResponse.json({ error: 'patient_id o visit_id es obligatorio' }, { status: 400 })
    }
    let q = supabase
      .from('clinic_files')
      .select('id, patient_id, visit_id, filename, mime_type, size_bytes, uploaded_by, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
    if (visitId) q = q.eq('visit_id', visitId)
    else if (patientId) q = q.eq('patient_id', patientId)
    const { data, error } = await q
    if (error) throw error
    return NextResponse.json({ files: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/clinic-files
 * { patient_id?, visit_id?, storage_path, filename, mime_type?, size_bytes? }
 *
 * The client uploads the object to the `clinic-files` bucket first
 * (account-scoped path), then records the metadata here.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const b = await request.json().catch(() => null)
    if (!b || typeof b !== 'object') {
      return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 })
    }
    const storagePath = typeof b.storage_path === 'string' ? b.storage_path : ''
    const filename = typeof b.filename === 'string' ? b.filename.trim().slice(0, 200) : ''
    const patientId = typeof b.patient_id === 'string' && UUID_RE.test(b.patient_id) ? b.patient_id : null
    const visitId = typeof b.visit_id === 'string' && UUID_RE.test(b.visit_id) ? b.visit_id : null
    if (!storagePath || !filename) {
      return NextResponse.json({ error: 'storage_path y filename son obligatorios' }, { status: 400 })
    }
    if (!patientId && !visitId) {
      return NextResponse.json({ error: 'patient_id o visit_id es obligatorio' }, { status: 400 })
    }
    // the path must sit under this account's folder
    if (!storagePath.startsWith(`account-${accountId}/`)) {
      return NextResponse.json({ error: 'Ruta de archivo inválida' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('clinic_files')
      .insert({
        account_id: accountId,
        patient_id: patientId,
        visit_id: visitId,
        storage_path: storagePath,
        filename,
        mime_type: typeof b.mime_type === 'string' ? b.mime_type.slice(0, 120) : null,
        size_bytes: Number.isFinite(Number(b.size_bytes)) ? Math.round(Number(b.size_bytes)) : null,
        uploaded_by: userId,
      })
      .select('id, patient_id, visit_id, filename, mime_type, size_bytes, uploaded_by, created_at')
      .single()
    if (error) {
      if (error.code === '23514') return NextResponse.json({ error: 'Referencia inválida' }, { status: 400 })
      if (error.code === '23505') return NextResponse.json({ error: 'Ese archivo ya está registrado' }, { status: 409 })
      throw error
    }
    return NextResponse.json({ file: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
