import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Visits — the clinical + financial record of a completed consultation.
// Editing the medical notes writes an append-only `visit_note_revisions`
// row (the previous text), so a note is never silently lost.
// ============================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface OpError {
  ok: false
  error: string
  status: number
}
function fail(error: string, status = 400): OpError {
  return { ok: false, error, status }
}

export interface CreateVisitInput {
  patient_id: string
  appointment_id?: string | null
  doctor_id?: string | null
  service_id?: string | null
  visit_date: string // yyyy-mm-dd
  amount?: number | null
  notes?: string | null
  observations?: string | null
  follow_up_date?: string | null
}

function cleanText(v: unknown, max = 8000): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}
function cleanAmount(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}
function cleanDate(v: unknown): string | null {
  return typeof v === 'string' && ISO_DATE.test(v) ? v : null
}

/**
 * Create a visit. When it's tied to an appointment that isn't yet
 * COMPLETED, the appointment is also flipped to COMPLETED (a visit *is*
 * the appointment having happened) with a history row.
 */
export async function createVisit(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  input: CreateVisitInput,
): Promise<{ ok: true; visit: Record<string, unknown> } | OpError> {
  if (!input.patient_id) return fail('patient_id es obligatorio')
  const visitDate = cleanDate(input.visit_date)
  if (!visitDate) return fail('visit_date inválida (yyyy-mm-dd)')

  // resolve amount from service if not given
  let amount = cleanAmount(input.amount)
  if (amount == null && input.service_id) {
    const { data } = await supabase
      .from('products')
      .select('price')
      .eq('account_id', accountId)
      .eq('id', input.service_id)
      .maybeSingle()
    const p = Number(data?.price)
    if (Number.isFinite(p) && p >= 0) amount = p
  }

  const row = {
    account_id: accountId,
    patient_id: input.patient_id,
    appointment_id: input.appointment_id ?? null,
    doctor_id: input.doctor_id ?? null,
    service_id: input.service_id ?? null,
    visit_date: visitDate,
    amount,
    notes: cleanText(input.notes),
    observations: cleanText(input.observations),
    follow_up_date: cleanDate(input.follow_up_date),
    created_by: userId,
    updated_by: userId,
  }

  const { data, error } = await supabase.from('visits').insert(row).select('*').single()
  if (error) {
    if (error.code === '23514') return fail('Datos de la visita inválidos')
    return fail(error.message, 500)
  }

  // first note revision (the starting text)
  if (row.notes || row.observations) {
    await supabase.from('visit_note_revisions').insert({
      account_id: accountId,
      visit_id: data.id,
      notes: row.notes,
      observations: row.observations,
      edited_by: userId,
    })
  }

  // close the linked appointment
  if (input.appointment_id) {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, status')
      .eq('account_id', accountId)
      .eq('id', input.appointment_id)
      .maybeSingle()
    if (appt && appt.status !== 'COMPLETED' && appt.status !== 'CANCELLED') {
      await supabase
        .from('appointments')
        .update({ status: 'COMPLETED', updated_by: userId })
        .eq('account_id', accountId)
        .eq('id', input.appointment_id)
      await supabase.from('appointment_history').insert({
        account_id: accountId,
        appointment_id: input.appointment_id,
        previous_status: appt.status,
        new_status: 'COMPLETED',
        reason: 'visit registered',
        changed_by: userId,
      })
    }
  }

  return { ok: true, visit: data }
}

export interface UpdateVisitInput {
  amount?: number | null
  notes?: string | null
  observations?: string | null
  follow_up_date?: string | null
  visit_date?: string
  doctor_id?: string | null
  service_id?: string | null
}

/**
 * Edit a visit. If `notes` or `observations` change, the PREVIOUS text
 * is preserved in `visit_note_revisions` before the update lands.
 */
export async function updateVisit(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  visitId: string,
  input: UpdateVisitInput,
): Promise<{ ok: true; visit: Record<string, unknown> } | OpError> {
  const { data: current, error: readErr } = await supabase
    .from('visits')
    .select('id, notes, observations')
    .eq('account_id', accountId)
    .eq('id', visitId)
    .maybeSingle()
  if (readErr) return fail(readErr.message, 500)
  if (!current) return fail('Visita no encontrada', 404)

  const patch: Record<string, unknown> = { updated_by: userId }
  let notesChanged = false
  if ('notes' in input) {
    patch.notes = cleanText(input.notes)
    if ((patch.notes ?? null) !== (current.notes ?? null)) notesChanged = true
  }
  if ('observations' in input) {
    patch.observations = cleanText(input.observations)
    if ((patch.observations ?? null) !== (current.observations ?? null)) notesChanged = true
  }
  if ('amount' in input) patch.amount = cleanAmount(input.amount)
  if ('visit_date' in input) {
    const d = cleanDate(input.visit_date)
    if (!d) return fail('visit_date inválida')
    patch.visit_date = d
  }
  if ('follow_up_date' in input) patch.follow_up_date = cleanDate(input.follow_up_date)
  if ('doctor_id' in input) patch.doctor_id = input.doctor_id || null
  if ('service_id' in input) patch.service_id = input.service_id || null

  if (Object.keys(patch).length === 1) return fail('Nada que actualizar')

  // snapshot the OLD note text before it changes
  if (notesChanged) {
    await supabase.from('visit_note_revisions').insert({
      account_id: accountId,
      visit_id: visitId,
      notes: current.notes,
      observations: current.observations,
      edited_by: userId,
    })
  }

  const { data, error } = await supabase
    .from('visits')
    .update(patch)
    .eq('account_id', accountId)
    .eq('id', visitId)
    .select('*')
    .maybeSingle()
  if (error) {
    if (error.code === '23514') return fail('Datos de la visita inválidos')
    return fail(error.message, 500)
  }
  if (!data) return fail('Visita no encontrada', 404)
  return { ok: true, visit: data }
}
