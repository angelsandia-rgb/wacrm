import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'

/** PATCH /api/note-templates/[id]  { name?, body? } — agent+. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const b = await request.json().catch(() => null)
    const patch: Record<string, unknown> = {}
    if ('name' in (b ?? {})) {
      const name = typeof b.name === 'string' ? b.name.trim() : ''
      if (name.length < 2 || name.length > 120) {
        return NextResponse.json({ error: 'El nombre debe tener 2–120 caracteres' }, { status: 400 })
      }
      patch.name = name
    }
    if ('body' in (b ?? {})) patch.body = typeof b.body === 'string' ? b.body.slice(0, 8000) : ''
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 })
    }
    const { data, error } = await supabase
      .from('note_templates')
      .update(patch)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) throw error
    if (!data) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
    return NextResponse.json({ template: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/note-templates/[id] — agent+. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const { error } = await supabase
      .from('note_templates')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
