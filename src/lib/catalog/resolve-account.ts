import type { SupabaseClient } from '@supabase/supabase-js'
import { looksLikeUuid } from './slug'

// The public catalog's `[accountId]` route segment is either the
// account UUID (the original, always-valid form) or its
// `catalog_slug` (migration 116, reached via the /c/<slug> rewrite).
// Everything downstream works in account UUIDs, so every public catalog
// route resolves the segment to one here first.

/**
 * Resolve a catalog URL segment (UUID or `catalog_slug`) to the real
 * account id. Returns null when it matches no account. Uses whatever
 * client is passed — the public routes pass a service-role client since
 * there's no session.
 */
export async function resolveCatalogAccountId(
  db: SupabaseClient,
  segment: string,
): Promise<string | null> {
  const v = segment.trim()
  if (!v) return null

  if (looksLikeUuid(v)) {
    const { data } = await db.from('accounts').select('id').eq('id', v).maybeSingle()
    return (data?.id as string) ?? null
  }

  const { data } = await db
    .from('accounts')
    .select('id')
    .eq('catalog_slug', v.toLowerCase())
    .maybeSingle()
  return (data?.id as string) ?? null
}
