import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'

/** GET /api/note-templates — the account's visit-note templates. */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { data, error } = await supabase
      .from('note_templates')
      .select('*')
      .eq('account_id', accountId)
      .order('name', { ascending: true })
    if (error) throw error
    return NextResponse.json({ templates: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST /api/note-templates  { name, body? } — agent+. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const b = await request.json().catch(() => null)
    const name = typeof b?.name === 'string' ? b.name.trim() : ''
    if (name.length < 2 || name.length > 120) {
      return NextResponse.json({ error: 'El nombre debe tener 2–120 caracteres' }, { status: 400 })
    }
    const { data, error } = await supabase
      .from('note_templates')
      .insert({
        account_id: accountId,
        name,
        body: typeof b?.body === 'string' ? b.body.slice(0, 8000) : '',
        created_by: userId,
      })
      .select('*')
      .single()
    if (error) throw error
    return NextResponse.json({ template: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
