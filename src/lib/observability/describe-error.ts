// ============================================================
// Turn any thrown value into a readable one-line string for logs and
// `system_alerts.detail`.
//
// The old idiom `err instanceof Error ? err.message : String(err)` broke
// on Supabase / PostgREST errors: they're plain objects (NOT `Error`
// instances), so `String(err)` produced the useless `"[object Object]"`
// — which is exactly what the 2026-09-07 hotel AI-outage alert recorded,
// hiding the real cause (a column a migration hadn't added yet).
// ============================================================

interface PostgrestLike {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
}

/**
 * A legible description of `err` for logs / alerts. Handles:
 *  - `Error` → `.message`
 *  - Supabase/PostgREST error shape `{ message, code, details, hint }`
 *  - anything else → JSON (never a bare `"[object Object]"`)
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as PostgrestLike;
    const parts: string[] = [];
    if (typeof e.message === 'string' && e.message.trim()) parts.push(e.message.trim());
    if (typeof e.code === 'string' && e.code.trim()) parts.push(`[${e.code.trim()}]`);
    if (typeof e.details === 'string' && e.details.trim()) parts.push(e.details.trim());
    if (typeof e.hint === 'string' && e.hint.trim()) parts.push(`(${e.hint.trim()})`);
    if (parts.length > 0) return parts.join(' ');
    try {
      const json = JSON.stringify(err);
      // `'{}'` is unhelpful but still honest ("an object carrying nothing")
      // — and, crucially, never the misleading `"[object Object]"`.
      if (json) return json;
    } catch {
      /* circular — fall through */
    }
  }
  return String(err);
}

/**
 * True when `err` is Postgres "undefined column" (SQLSTATE 42703) — the
 * signature of application code that was deployed ahead of the migration
 * that adds the column it selects. The caller can then degrade to the
 * pre-migration column set instead of failing the whole operation.
 */
export function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as PostgrestLike;
  if (e.code === '42703') return true;
  return typeof e.message === 'string' && /column .* does not exist/i.test(e.message);
}
