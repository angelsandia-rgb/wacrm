import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// The route is a thin validate-and-forward layer over the
// transfer_account_ownership RPC (all the real authority checks live in the
// SECURITY DEFINER function, migration 138). What's worth covering here:
//   1. `demoteToRole` is optional and passed through only when given.
//   2. An invalid `demoteToRole` is rejected before ever calling the RPC.
//   3. A valid `demoteToRole` ('agent', per Angel's 2026-09-17 request to
//      demote an outgoing owner straight to "Vendedor") reaches the RPC call.
// ---------------------------------------------------------------------------

const NEW_OWNER = '11111111-1111-1111-1111-111111111111'

const rpcCalls: { name: string; args: unknown }[] = []

function supabaseMock() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === 'profiles') {
              return { data: { account_id: 'acct-1', account_role: 'owner' }, error: null }
            }
            if (table === 'accounts') {
              return { data: { id: 'acct-1', name: 'Villa San Ricardo' }, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
    }),
    auth: {
      getUser: async () => ({ data: { user: { id: 'owner-user-1' } }, error: null }),
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock()),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: { limit: 30, windowSeconds: 60 } },
}))

import { POST } from './route'

function req(body: Record<string, unknown>): Request {
  return new Request('http://test/api/account/transfer-ownership', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  rpcCalls.length = 0
})

describe('POST /api/account/transfer-ownership', () => {
  it('rejects an invalid demoteToRole before calling the RPC', async () => {
    const res = await POST(req({ newOwnerUserId: NEW_OWNER, demoteToRole: 'owner' }))
    expect(res.status).toBe(400)
    expect(rpcCalls).toEqual([])
  })

  it('omits p_demote_to_role when the caller does not specify one (RPC default applies)', async () => {
    const res = await POST(req({ newOwnerUserId: NEW_OWNER }))
    expect(res.status).toBe(200)
    expect(rpcCalls).toEqual([
      { name: 'transfer_account_ownership', args: { p_new_owner_user_id: NEW_OWNER } },
    ])
  })

  it("passes 'agent' through to demote the outgoing owner straight to Vendedor", async () => {
    const res = await POST(req({ newOwnerUserId: NEW_OWNER, demoteToRole: 'agent' }))
    expect(res.status).toBe(200)
    expect(rpcCalls).toEqual([
      {
        name: 'transfer_account_ownership',
        args: { p_new_owner_user_id: NEW_OWNER, p_demote_to_role: 'agent' },
      },
    ])
  })
})
