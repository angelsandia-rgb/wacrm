import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * POST /api/contacts/[id]/merge
 *
 * Folds `duplicateId` into this contact via `merge_contacts` (migration
 * 175): conversations, deals, tags, notes, tasks… move here and the
 * duplicate is deleted. Admin+ only (the function re-checks).
 *
 * Body: { duplicateId: string }
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireRole('admin')
    const { id } = await context.params
    const body = await request.json().catch(() => null)
    const duplicateId = typeof body?.duplicateId === 'string' ? body.duplicateId : ''
    if (!duplicateId || duplicateId === id) {
      return NextResponse.json({ error: 'duplicateId must be another contact' }, { status: 400 })
    }

    const { error } = await supabase.rpc('merge_contacts', { p_keep: id, p_duplicate: duplicateId })
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          {
            error: error.message.includes('patient')
              ? 'Ambos contactos tienen ficha de paciente; no se pueden unir automáticamente.'
              : 'Ambos contactos tienen un chat en el mismo número de WhatsApp; no se pueden unir automáticamente.',
          },
          { status: 409 },
        )
      }
      if (error.code === '42501') return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      console.error('[contacts/merge] rpc failed:', error)
      return NextResponse.json({ error: 'Failed to merge contacts' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
