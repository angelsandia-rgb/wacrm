import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export const COMMERCIAL_OPT_OUT_TAG = 'Sin promociones'

/** Deliberately narrow: a refusal to buy, quoted example or request to keep
 * receiving messages is not a marketing unsubscribe. */
export function detectCommercialOptOut(text: string): boolean {
  const value = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/["“«][^"”»]*["”»]/g, ' ')
    .replace(/'[^']*'/g, ' ').trim()
  if (/^(?:stop|unsubscribe|baja)[.!\s]*$/.test(value)) return true
  if (/\bno\s+(?:dejes?|dejen|pare[ns]?|pares|paren)\s+de\s+(?:enviar|mandar|escribir)/.test(value)) return false
  if (/\b(?:ejemplo|cita|traduc\w*|traduce|traduzca\w*|como (?:se )?dice|dijo|dijeron|escribio|escribieron)\b/.test(value)) return false
  return /\bno\s+(?:me\s+)?(?:escribas?|escriban|mandes?|manden|envies?|envien)\s+(?:mas|(?:mas\s+)?(?:mensajes|promociones|publicidad|ofertas))\b/.test(value)
    || /\bno\s+(?:quiero|deseo)\s+(?:recibir\s+)?(?:mas\s+)?(?:mensajes|promociones|publicidad|ofertas)\b/.test(value)
    || /\b(?:deja|deje|dejen|paren)\s+de\s+(?:enviarme|mandarme|escribirme)\b/.test(value)
    || /\b(?:dame|deme|denme|quiero|solicito)\s+(?:darme\s+)?de\s+baja\b/.test(value)
    || /\bno\s+(?:mas\s+)?(?:promociones|publicidad|ofertas)\b/.test(value)
}

function tagIdForAccount(accountId: string): string {
  const bytes = createHash('sha256').update(`commercial-opt-out\0${accountId}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Save only the commercial exclusion. Other tags, normal replies and
 * transactional order updates remain untouched. Safe on retries. */
export async function persistCommercialOptOut(db: SupabaseClient, accountId: string, contactId: string): Promise<void> {
  const { data: contact, error: contactError } = await db.from('contacts').select('id,user_id')
    .eq('id', contactId).eq('account_id', accountId).maybeSingle()
  if (contactError || !contact?.user_id) throw new Error('Cannot verify commercial preference contact ownership')
  const { data: existing, error: lookupError } = await db.from('tags').select('id')
    .eq('account_id', accountId).ilike('name', COMMERCIAL_OPT_OUT_TAG).order('created_at').limit(1).maybeSingle()
  if (lookupError) throw new Error(`Cannot read commercial preference tag: ${lookupError.message}`)
  const tagId = existing?.id ?? tagIdForAccount(accountId)
  if (!existing) {
    // The schema has no unique account/name constraint. A deterministic ID
    // gives concurrent workers one definition without adding a migration.
    const { error } = await db.from('tags').upsert({
      id: tagId, account_id: accountId, user_id: contact.user_id,
      name: COMMERCIAL_OPT_OUT_TAG, color: '#64748b',
    }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw new Error(`Cannot save commercial preference tag: ${error.message}`)
  }
  const { data: ownedTag, error: ownershipError } = await db.from('tags').select('id')
    .eq('id', tagId).eq('account_id', accountId).maybeSingle()
  if (ownershipError || !ownedTag) throw new Error('Cannot verify commercial preference tag ownership')
  const { error } = await db.from('contact_tags').upsert({ contact_id: contactId, tag_id: tagId }, {
    onConflict: 'contact_id,tag_id', ignoreDuplicates: true,
  })
  if (error) throw new Error(`Cannot save commercial opt-out: ${error.message}`)
}

/** Marketing fails closed on a read error: postpone a promotion rather than
 * override a preference that might already be saved. */
export async function contactMutesCommercial(db: SupabaseClient, accountId: string, contactId: string | null | undefined): Promise<boolean> {
  if (!contactId) return false
  const { data: contact, error: ownershipError } = await db.from('contacts').select('id')
    .eq('id', contactId).eq('account_id', accountId).maybeSingle()
  if (ownershipError) throw new Error(`Cannot verify commercial preference contact: ${ownershipError.message}`)
  if (!contact) return true
  const { data, error } = await db.from('contact_tags').select('tags!inner(name,account_id)')
    .eq('contact_id', contactId).eq('tags.account_id', accountId)
  if (error) throw new Error(`Cannot read commercial preference: ${error.message}`)
  return (data ?? []).some((row) => {
    const tag = row.tags as { name?: string; account_id?: string } | { name?: string; account_id?: string }[] | null
    return (Array.isArray(tag) ? tag : [tag]).some((t) => t?.account_id === accountId
      && t.name?.trim().toLowerCase() === COMMERCIAL_OPT_OUT_TAG.toLowerCase())
  })
}
