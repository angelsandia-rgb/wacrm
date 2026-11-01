import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { notifyContactFieldsUpdated } from '@/lib/automations/events'

/**
 * PUT /api/contacts/[id]/custom-values
 *
 * Replaces a contact's custom field values — the server-side counterpart
 * of the Contact detail panel's custom fields form, which used to write
 * straight to Supabase from the browser. Moved here so a changed value
 * fires the `contact_field_updated` automation trigger.
 *
 * Body: { values: { [custom_field_id]: string } } — an empty string
 * clears the value.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await context.params
    const body = await request.json().catch(() => null)
    const raw = body && typeof body === 'object' ? (body as { values?: unknown }).values : null
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json({ error: 'values must be an object' }, { status: 400 })
    }

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const [{ data: fields }, { data: current }] = await Promise.all([
      supabase.from('custom_fields').select('id').eq('account_id', accountId),
      supabase.from('contact_custom_values').select('custom_field_id, value').eq('contact_id', id),
    ])
    const known = new Set((fields ?? []).map((f) => f.id as string))
    const before = new Map((current ?? []).map((r) => [r.custom_field_id as string, (r.value as string) ?? '']))

    const next = new Map<string, string>()
    for (const [fieldId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!known.has(fieldId)) continue
      next.set(fieldId, typeof value === 'string' ? value.trim() : '')
    }

    const changed = Array.from(next.entries()).filter(([fieldId, value]) => (before.get(fieldId) ?? '') !== value)
    const toClear = changed.filter(([, v]) => !v).map(([fieldId]) => fieldId)
    const toSet = changed.filter(([, v]) => v).map(([fieldId, value]) => ({ contact_id: id, custom_field_id: fieldId, value }))

    if (toClear.length > 0) {
      const { error } = await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', id)
        .in('custom_field_id', toClear)
      if (error) throw error
    }
    if (toSet.length > 0) {
      const { error } = await supabase
        .from('contact_custom_values')
        .upsert(toSet, { onConflict: 'contact_id,custom_field_id' })
      if (error) throw error
    }

    if (changed.length > 0) {
      const fieldKeys = changed.map(([fieldId]) => `custom:${fieldId}`)
      after(() => notifyContactFieldsUpdated({ accountId, contactId: id, fields: fieldKeys }))
    }

    return NextResponse.json({ success: true, changed: changed.length })
  } catch (error) {
    console.error('Error in contacts/[id]/custom-values PUT:', error)
    return toErrorResponse(error)
  }
}
