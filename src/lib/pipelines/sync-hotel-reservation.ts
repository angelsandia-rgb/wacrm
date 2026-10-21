import type { SupabaseClient } from '@supabase/supabase-js'
import { hotelStageKind, reservationStageKind } from './hotel-stages'

/** Only accounts opting into the canonical hotel stages are affected.
 * Never changes a reservation, sends a message or interprets silence as rejection.
 * Existing closed opportunities stay closed during ordinary AI enrichment. */
export async function syncHotelReservationDeal(db: SupabaseClient, accountId: string, reservationId: string): Promise<void> {
  try {
    const { data: account } = await db.from('accounts').select('industry_vertical, owner_user_id, default_currency').eq('id', accountId).maybeSingle()
    if (account?.industry_vertical !== 'hotel') return
    const { data: r } = await db.from('reservation_requests').select('id, category, status, guest_confirmed_at, contact_id, conversation_id, service_name, estimated_price, is_active_build').eq('id', reservationId).eq('account_id', accountId).maybeSingle()
    if (!r?.contact_id || r.is_active_build === false) return
    const { data: pipelines } = await db.from('pipelines').select('id, name').eq('account_id', accountId)
    const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const pipeline = pipelines?.find(p => normalize(p.name).includes(normalize(r.category)))
    if (!pipeline) return
    const { data: stages } = await db.from('pipeline_stages').select('id, name, is_won').eq('pipeline_id', pipeline.id)
    const kind = reservationStageKind(r.status, r.guest_confirmed_at)
    const target = stages?.find(s => hotelStageKind(s.name) === kind)
    if (!target || (kind === 'confirmed' && !target.is_won)) return
    const reference = `Solicitud de reserva: ${r.id}`
    if (!r.conversation_id) return
    const { data: deals, error: dealsError } = await db.from('deals').select('id, notes, status, stage_id').eq('account_id', accountId).eq('pipeline_id', pipeline.id).eq('contact_id', r.contact_id).or(`conversation_id.eq.${r.conversation_id},conversation_id.is.null`).order('created_at', { ascending: false })
    if (dealsError) throw dealsError
    const linked = deals?.find(d => d.notes?.includes(reference))
    const existing = linked ?? deals?.find(d => d.status === 'open' && !d.notes?.includes('Solicitud de reserva:'))
    // Do not recreate or reopen manually closed opportunities on an AI update.
    if (kind === 'quote' || kind === 'pending') {
      if (linked && linked.status !== 'open') return
      if (!existing && deals?.some(d => d.status !== 'open')) return
      if (existing && hotelStageKind(stages?.find(s => s.id === existing.stage_id)?.name) === 'pending' && kind === 'quote') return
    }
    const state = { stage_id: target.id, status: kind === 'confirmed' ? 'won' : kind === 'discard' ? 'lost' : 'open',
      ...(kind === 'confirmed' ? { won_at: new Date().toISOString() } : { won_at: null }) }
    if (existing) {
      if (linked && existing.stage_id === target.id && existing.status === state.status) return
      const { error } = await db.from('deals').update({ ...state, conversation_id: r.conversation_id, notes: linked ? existing.notes : [existing.notes, reference].filter(Boolean).join('\n') }).eq('id', existing.id).eq('account_id', accountId).eq('status', existing.status)
      if (error) throw error
    } else {
      // Stable per-request ID makes concurrent event retries an insert-once operation.
      const { error } = await db.from('deals').upsert({ ...state, id: r.id, account_id: accountId, user_id: account.owner_user_id, pipeline_id: pipeline.id, contact_id: r.contact_id, conversation_id: r.conversation_id,
        title: r.service_name || 'Solicitud del hotel', value: r.estimated_price ?? 0, currency: account.default_currency ?? 'GTQ', notes: reference }, { onConflict: 'id', ignoreDuplicates: true })
      if (error) throw error
    }
  } catch (error) {
    console.error('[hotel pipeline] reservation synchronization failed', reservationId, error)
  }
}
