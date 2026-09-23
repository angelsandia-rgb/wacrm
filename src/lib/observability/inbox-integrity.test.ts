import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/platform/admin-client', () => ({
  platformAdminClient: () => ({ from: h.from }),
}));

import { checkInboxIntegrity } from './inbox-integrity';

/** `db.from(table).select(...).in(...)`, keyset-paged like the real
 *  reads (`fetchAllRows`): honours `.gt('id', cursor)` so paging ends.
 *  `results` maps a table name to its rows (ids synthesized if absent). */
function mockTables(results: Record<string, { data: unknown[]; error: unknown }>) {
  h.from.mockImplementation((table: string) => {
    const res = results[table] ?? { data: [], error: null };
    const rows = (res.data as Record<string, unknown>[]).map((r, i) => ({
      id: `${table}-${String(i).padStart(4, '0')}`,
      ...r,
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    let cursor = '';
    const chain: Record<string, unknown> = {
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      gt: (_c: string, v: string) => {
        cursor = v;
        return chain;
      },
      then: (resolve: (v: unknown) => void) =>
        resolve(
          res.error
            ? { data: null, error: res.error }
            : { data: rows.filter((r) => String(r.id) > cursor), error: null },
        ),
    };
    return { select: () => chain };
  });
}

beforeEach(() => h.from.mockReset());

describe('checkInboxIntegrity', () => {
  it('reports a clean inbox', async () => {
    mockTables({
      conversations: {
        data: [
          { id: 'c1', account_id: 'a', contact_id: 'k1', channel: 'instagram', zernio_conversation_id: 'z1' },
          { id: 'c2', account_id: 'a', contact_id: 'k2', channel: 'facebook', zernio_conversation_id: 'z2' },
        ],
        error: null,
      },
    });
    const r = await checkInboxIntegrity();
    expect(r).toEqual({ unrepliableConversationIds: [], duplicateThreadGroups: 0, scanFailed: false });
  });

  it('flags a conversation with traffic but no zernio id', async () => {
    mockTables({
      conversations: {
        data: [
          { id: 'orphan', account_id: 'a', contact_id: 'k1', channel: 'instagram', zernio_conversation_id: null },
          { id: 'idless-empty', account_id: 'a', contact_id: 'k9', channel: 'instagram', zernio_conversation_id: null },
        ],
        error: null,
      },
      // only `orphan` has messages
      messages: { data: [{ conversation_id: 'orphan' }], error: null },
    });
    const r = await checkInboxIntegrity();
    expect(r.unrepliableConversationIds).toEqual(['orphan']);
    expect(r.scanFailed).toBe(false);
  });

  it('counts duplicate (account, contact, channel) thread groups', async () => {
    mockTables({
      conversations: {
        data: [
          { id: 'c1', account_id: 'a', contact_id: 'k1', channel: 'instagram', zernio_conversation_id: 'z1' },
          { id: 'c2', account_id: 'a', contact_id: 'k1', channel: 'instagram', zernio_conversation_id: 'z2' },
          { id: 'c3', account_id: 'a', contact_id: 'k1', channel: 'facebook', zernio_conversation_id: 'z3' },
        ],
        error: null,
      },
    });
    const r = await checkInboxIntegrity();
    expect(r.duplicateThreadGroups).toBe(1); // k1/instagram has 2; k1/facebook has 1
  });

  it('returns scanFailed on a query error (never throws)', async () => {
    mockTables({ conversations: { data: [], error: { message: 'boom' } } });
    const r = await checkInboxIntegrity();
    expect(r.scanFailed).toBe(true);
  });
});
