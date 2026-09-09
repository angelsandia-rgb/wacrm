import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { dateKeyInZone } from '@/lib/timezone'
import { isPatientSource } from '@/lib/clinic/types'
import { listPatients, isPatientFilter } from '@/lib/clinic/patients'

/**
 * GET /api/patients?filter=&search=&limit=&offset=
 *
 * The clinic vertical's patient list — each row carries last visit,
 * next appointment, visit count, lifetime value and a follow-up-due
 * flag (see `src/lib/clinic/patients.ts`). RLS-scoped to the caller's
 * account; a restricted doctor-user only sees patients they have an
 * appointment / visit with, indirectly, via the aggregate reads.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const url = new URL(request.url)

    // ?contact_id=… → a single lookup ("does this contact have a patient
    // profile?"), used by the "Convertir en paciente" button in Contactos.
    const contactId = url.searchParams.get('contact_id')
    if (contactId) {
      const { data } = await supabase
        .from('patient_profiles')
        .select('id, contact_id, source, created_at')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .maybeSingle()
      return NextResponse.json({ patient: data ?? null })
    }

    const filterParam = url.searchParams.get('filter')
    const filter = isPatientFilter(filterParam) ? filterParam : 'all'
    const search = url.searchParams.get('search') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const offset = Number(url.searchParams.get('offset') ?? '0')

    const { data: acct } = await supabase
      .from('accounts')
      .select('timezone')
      .eq('id', accountId)
      .maybeSingle()
    const tz = (acct?.timezone as string | null) || 'UTC'
    const now = new Date()

    const result = await listPatients(supabase, accountId, {
      filter,
      search,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      nowISO: now.toISOString(),
      todayISODate: dateKeyInZone(now, tz),
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/patients  { contact_id, source? }
 *
 * "Convertir en paciente" — creates the thin `patient_profiles` row for
 * an existing contact. Idempotent: returns the existing profile if the
 * contact already has one.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const body = await request.json().catch(() => null)
    const contactId = typeof body?.contact_id === 'string' ? body.contact_id : ''
    if (!contactId) {
      return NextResponse.json({ error: 'contact_id is required' }, { status: 400 })
    }
    const source =
      typeof body?.source === 'string' && isPatientSource(body.source) ? body.source : null

    // contact must belong to this account (the tenant guard trigger also
    // enforces it, but a clean 404 is friendlier than a 23514).
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!contact) {
      return NextResponse.json({ error: 'Contacto no encontrado' }, { status: 404 })
    }

    const { data: existing } = await supabase
      .from('patient_profiles')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (existing) return NextResponse.json({ patient: existing, created: false })

    const { data, error } = await supabase
      .from('patient_profiles')
      .insert({ account_id: accountId, contact_id: contactId, source })
      .select('*')
      .single()
    if (error) {
      // unique(contact_id) race → fetch the winner
      if (error.code === '23505') {
        const { data: winner } = await supabase
          .from('patient_profiles')
          .select('*')
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .maybeSingle()
        if (winner) return NextResponse.json({ patient: winner, created: false })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ patient: data, created: true }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
