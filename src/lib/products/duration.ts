/**
 * `products.duration_minutes` (migration 122) — the default slot length
 * of a clinic service. Shared by POST /api/products and
 * PATCH /api/products/[id]. `undefined` in the body = leave as-is on a
 * PATCH; `null` / `''` clears it.
 */
export type DurationParse =
  | { ok: true; provided: boolean; value: number | null }
  | { ok: false; error: string }

export function parseDurationMinutes(raw: unknown): DurationParse {
  if (raw === undefined) return { ok: true, provided: false, value: null }
  if (raw === null || raw === '') return { ok: true, provided: true, value: null }
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1440) {
    return { ok: false, error: 'duration_minutes must be an integer between 1 and 1440' }
  }
  return { ok: true, provided: true, value: n }
}
