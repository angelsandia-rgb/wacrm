import { describe, expect, it, vi } from 'vitest'
import { fetchAllRows, fetchAllRowsIn } from './fetch-all'

/** A fake builder that, like PostgREST, caps every response at `serverCap`
 *  regardless of the requested limit. */
function table(rows: { id: string }[], serverCap = 1000, error: unknown = null) {
  const calls = { pages: 0 }
  const build = () => {
    let cursor = ''
    let limit = Infinity
    const chain = {
      order: () => chain,
      limit: (n: number) => {
        limit = n
        return chain
      },
      gt: (_: string, value: string) => {
        cursor = value
        return chain
      },
      then: (resolve: (v: unknown) => void) => {
        calls.pages += 1
        resolve({
          data: rows.filter((r) => r.id > cursor).slice(0, Math.min(limit, serverCap)),
          error,
        })
      },
    }
    return chain
  }
  return { build, calls }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(6, '0') }))

describe('fetchAllRows', () => {
  it('reads every row past the server row cap', async () => {
    const t = table(ids(2500))
    const rows = await fetchAllRows(t.build)
    expect(rows).toHaveLength(2500)
    expect(rows[2499].id).toBe('002499')
  })

  it('stays complete when the server cap is below the requested page size', async () => {
    const t = table(ids(1205), 100)
    expect(await fetchAllRows(t.build, { pageSize: 1000 })).toHaveLength(1205)
  })

  it('returns an empty list for no matches', async () => {
    expect(await fetchAllRows(table([]).build)).toEqual([])
  })

  it('throws instead of aggregating a partial set past maxRows', async () => {
    await expect(fetchAllRows(table(ids(30)).build, { pageSize: 10, maxRows: 20, label: 'kpis' })).rejects.toThrow(
      'kpis: more than 20 rows',
    )
  })

  it('surfaces query errors', async () => {
    await expect(fetchAllRows(table([], 1000, new Error('offline')).build)).rejects.toThrow('offline')
  })

  it('builds a fresh query per page', async () => {
    const t = table(ids(25))
    const build = vi.fn(t.build)
    await fetchAllRows(build, { pageSize: 10 })
    expect(build).toHaveBeenCalledTimes(4) // 10 + 10 + 5 + the empty page
  })
})

describe('fetchAllRowsIn', () => {
  it('queries each id chunk separately and concatenates every page', async () => {
    const all = ids(30)
    const seen: string[][] = []
    const rows = await fetchAllRowsIn(
      all.map((r) => r.id),
      (chunk) => {
        seen.push(chunk)
        return table(all.filter((r) => chunk.includes(r.id)), 4).build()
      },
      { chunkSize: 12 },
    )
    expect(rows).toHaveLength(30)
    expect(new Set(seen.map((c) => c.length))).toEqual(new Set([12, 6]))
  })

  it('skips the query entirely for no ids', async () => {
    const build = vi.fn()
    expect(await fetchAllRowsIn([], build)).toEqual([])
    expect(build).not.toHaveBeenCalled()
  })
})
