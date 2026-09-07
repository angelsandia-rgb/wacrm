// ============================================================
// Public-catalog handle (`accounts.catalog_slug`, migration 116).
//
// The catalog page is served at /catalog/<uuid> (always) and, when a
// slug is set, at the shorter /c/<slug> (a next.config rewrite to the
// same route). Kept in sync with the DB CHECK constraint
// `accounts_catalog_slug_format`: lowercase, 3–40 chars, [a-z0-9]
// segments joined by single hyphens.
// ============================================================

export const CATALOG_SLUG_MIN = 3
export const CATALOG_SLUG_MAX = 40

/** True when `s` is already a valid stored slug. */
export function isValidCatalogSlug(s: string): boolean {
  return (
    s.length >= CATALOG_SLUG_MIN &&
    s.length <= CATALOG_SLUG_MAX &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)
  )
}

/**
 * Best-effort slug from free text (a company name, or what the owner
 * typed in the settings field). Folds common Spanish accents, lowercases,
 * collapses every run of non-alphanumerics to a single hyphen, trims
 * hyphens, truncates to 40. Returns '' when nothing usable is left — the
 * caller decides the fallback (the SQL backfill uses 'catalogo').
 */
export function slugifyCatalog(input: string): string {
  const folded = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
  return folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CATALOG_SLUG_MAX)
    .replace(/-+$/g, '')
}

/** A 36-char UUID — the other thing the `[accountId]` route segment can be. */
export function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}
