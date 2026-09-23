import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  events: [] as string[],
  // bucket -> remaining object paths
  storage: new Map<string, string[]>(),
  accountDeleteError: null as { message: string } | null,
}))

vi.mock('@/lib/auth/account', () => ({
  requirePlatformAdmin: async () => ({ accountId: 'platform-acct' }),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }),
}))

vi.mock('@/lib/platform/admin-client', () => ({
  platformAdminClient: () => ({
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: 'acct-1', name: 'Clínica Uno', owner_user_id: 'u-owner' },
              error: null,
            }),
            then: (resolve: (v: unknown) => void) =>
              resolve({ data: [{ user_id: 'u-owner' }, { user_id: 'u-2' }], error: null }),
          }),
        }),
        delete: () => ({
          eq: async () => {
            h.events.push(`delete:${table}`)
            return { error: table === 'accounts' ? h.accountDeleteError : null }
          },
        }),
      }
    },
    storage: {
      from(bucket: string) {
        return {
          // Like Supabase Storage: a listing reflects prior removals.
          list: async (prefix: string, opts: { limit: number; offset?: number }) => {
            const all = (h.storage.get(bucket) ?? []).filter((p) => p.startsWith(`${prefix}/`))
            const start = opts.offset ?? 0
            return {
              data: all.slice(start, start + opts.limit).map((p) => ({ name: p.slice(prefix.length + 1) })),
              error: null,
            }
          },
          remove: async (paths: string[]) => {
            h.events.push(`storage:${bucket}`)
            h.storage.set(bucket, (h.storage.get(bucket) ?? []).filter((p) => !paths.includes(p)))
            return { error: null }
          },
        }
      },
    },
    auth: { admin: { deleteUser: async () => ({ error: null }) } },
  }),
}))

import { POST } from './route'

const call = () =>
  POST(
    new Request('https://crm.test/api/admin/companies/acct-1/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm_name: 'clínica uno' }),
    }),
    { params: Promise.resolve({ id: 'acct-1' }) },
  )

beforeEach(() => {
  h.events = []
  h.accountDeleteError = null
  h.storage = new Map([
    ['chat-media', Array.from({ length: 2500 }, (_, i) => `account-acct-1/f${i}.jpg`)],
    ['clinic-files', ['account-acct-1/historia.pdf']],
    ['avatars', ['u-2/avatar-1.png', 'someone-else/avatar.png']],
  ])
})

describe('admin company delete', () => {
  it('removes every file (past 1000), clinic files and member avatars', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(h.storage.get('chat-media')).toEqual([])
    expect(h.storage.get('clinic-files')).toEqual([])
    expect(h.storage.get('avatars')).toEqual(['someone-else/avatar.png'])
  })

  it('deletes the account row before touching storage', async () => {
    await call()
    const accountAt = h.events.indexOf('delete:accounts')
    const firstStorage = h.events.findIndex((e) => e.startsWith('storage:'))
    expect(accountAt).toBeGreaterThanOrEqual(0)
    expect(firstStorage).toBeGreaterThan(accountAt)
  })

  it('keeps every file when the account delete fails', async () => {
    h.accountDeleteError = { message: 'fk violation' }
    const res = await call()
    expect(res.status).toBe(500)
    expect(h.storage.get('chat-media')).toHaveLength(2500)
    expect(h.events.some((e) => e.startsWith('storage:'))).toBe(false)
  })
})
