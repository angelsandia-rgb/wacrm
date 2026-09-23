// ============================================================
// Read every row a filtered query matches, past PostgREST's server-side
// row cap (`max_rows`, 1000 on this project).
//
// A plain `.select()` — even with `.limit(50000)` — silently stops at the
// server cap, so an aggregate computed from it (a KPI, a chart series) is
// quietly wrong once an account outgrows the cap. This pages by `id`
// (keyset, stable under concurrent inserts) until an empty page, which
// also stays correct if the server cap is lower than our page size.
//
// Client-safe: no server-only imports. RLS still scopes every page.
// ============================================================

/** Chainable subset of a PostgREST filter builder that keyset paging needs. */
interface KeysetQuery {
  order(column: string, options?: { ascending?: boolean }): KeysetQuery
  limit(count: number): KeysetQuery
  gt(column: string, value: string): KeysetQuery
  then: PromiseLike<{ data: unknown[] | null; error: unknown }>['then']
}

export interface FetchAllOptions {
  /** Rows requested per page. The server may return fewer. */
  pageSize?: number
  /** Hard ceiling — past it we throw rather than aggregate a partial set. */
  maxRows?: number
  /** Names the query in the "too many rows" / "did not advance" errors. */
  label?: string
}

/**
 * `build` must return a FRESH, already-filtered query that selects `id`
 * (it's called once per page). Don't add `.order()` / `.limit()` — the
 * paging owns both. Rows come back in `id` order; sort in the caller if
 * the aggregate needs another order.
 */
export async function fetchAllRows<T extends { id: string }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
  { pageSize = 1000, maxRows = 50_000, label = 'query' }: FetchAllOptions = {},
): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | null = null
  for (;;) {
    let query = (build() as KeysetQuery).order('id', { ascending: true }).limit(pageSize)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw error
    if (!data || data.length === 0) return rows
    const page = data as T[]
    rows.push(...page)
    if (rows.length > maxRows) {
      throw new Error(`${label}: more than ${maxRows} rows — needs server-side aggregation`)
    }
    const next = page[page.length - 1].id
    if (!next || next === cursor) throw new Error(`${label}: pagination did not advance`)
    cursor = next
  }
}

/**
 * `fetchAllRows` over an `.in(column, ids)` filter, split into chunks so
 * the request URL stays under the gateway's length limit (a UUID is ~37
 * encoded chars; a few hundred of them already overflow it).
 * `build(chunk)` returns a fresh filtered query for one chunk of ids.
 */
export async function fetchAllRowsIn<T extends { id: string }>(
  ids: readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (chunk: string[]) => any,
  { chunkSize = 200, ...options }: FetchAllOptions & { chunkSize?: number } = {},
): Promise<T[]> {
  const unique = [...new Set(ids)]
  const rows: T[] = []
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize)
    rows.push(...(await fetchAllRows<T>(() => build(chunk), options)))
  }
  return rows
}
