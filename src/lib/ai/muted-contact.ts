/**
 * Contacts the AI must never answer: staff, family/personal chats and
 * suppliers that share the business's WhatsApp number (VSR 2026-10-09:
 * asked "¿Está el Enterovid en su pañalera?" in a family chat, the bot
 * invented "Sí, va el Enterovid…"). The team marks them with a plain
 * contact tag — no new UI, the tag picker already exists.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const MUTE_TAGS = new Set(['interno', 'personal', 'proveedor', 'sin ia'])

export function isAiMuteTag(name: string | null | undefined): boolean {
  const key = (name ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()
  return MUTE_TAGS.has(key)
}

/** True when the contact carries a mute tag. Fails open (false) on a
 *  read error — a lookup hiccup must not silence real guests. */
export async function contactMutesAi(db: SupabaseClient, contactId: string | null | undefined): Promise<boolean> {
  if (!contactId) return false
  try {
    const { data, error } = await db.from('contact_tags').select('tags(name)').eq('contact_id', contactId)
    if (error || !Array.isArray(data)) return false
    return data.some((row) => {
      const tags = (row as { tags?: { name?: string } | { name?: string }[] | null }).tags
      return (Array.isArray(tags) ? tags : [tags]).some((t) => isAiMuteTag(t?.name))
    })
  } catch {
    return false
  }
}
