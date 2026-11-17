/**
 * Contacts the AI must never answer: staff, family/personal chats and
 * suppliers that share the business's WhatsApp number (VSR 2026-10-09:
 * asked "¿Está el Enterovid en su pañalera?" in a family chat, the bot
 * invented "Sí, va el Enterovid…"). The team marks them with a plain
 * contact tag — no new UI, the tag picker already exists.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasFeature } from '@/lib/features/flags'

const MUTE_TAGS = new Set(['interno', 'personal', 'proveedor', 'sin ia'])
/** With the account flag `ai_test_contacts_only`, only contacts with this tag get the AI. */
const TEST_TAG = 'prueba ia'

const tagKey = (name: string | null | undefined) => (name ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()

export function isAiMuteTag(name: string | null | undefined): boolean {
  return MUTE_TAGS.has(tagKey(name))
}

/** Pure: whether the AI stays out, from the contact's tags and the test-only switch. */
export function aiSilencedByTags(tagNames: (string | null | undefined)[], testOnly: boolean): boolean {
  return tagNames.some(isAiMuteTag) || (testOnly && !tagNames.some((n) => tagKey(n) === TEST_TAG))
}

/** True when the contact carries a mute tag — or, given the account and
 *  with its test-only switch on, when it is not tagged "Prueba IA". Fails
 *  open (false) on a read error — a lookup hiccup must not silence real guests. */
export async function contactMutesAi(db: SupabaseClient, contactId: string | null | undefined, accountId?: string): Promise<boolean> {
  if (!contactId) return false
  try {
    const { data, error } = await db.from('contact_tags').select('tags(name)').eq('contact_id', contactId)
    if (error || !Array.isArray(data)) return false
    const names = data.flatMap((row) => {
      const tags = (row as { tags?: { name?: string } | { name?: string }[] | null }).tags
      return (Array.isArray(tags) ? tags : [tags]).map((t) => t?.name)
    })
    let testOnly = false
    if (accountId) {
      const { data: account, error: accountError } = await db.from('accounts').select('feature_flags').eq('id', accountId).maybeSingle()
      testOnly = !accountError && hasFeature(account?.feature_flags, 'ai_test_contacts_only')
    }
    return aiSilencedByTags(names, testOnly)
  } catch {
    return false
  }
}
