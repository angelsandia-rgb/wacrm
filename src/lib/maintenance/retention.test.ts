import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isExpiredStorageObject, isReferenced } from './retention';

const cutoff = new Date('2026-08-01T00:00:00.000Z');

describe('isExpiredStorageObject', () => {
  it('accepts objects created before the cutoff', () => {
    expect(
      isExpiredStorageObject(
        { name: 'old', created_at: '2026-07-01T00:00:00Z' },
        cutoff
      )
    ).toBe(true);
  });

  it('keeps recent and undated objects', () => {
    expect(
      isExpiredStorageObject(
        { name: 'new', created_at: '2026-08-02T00:00:00Z' },
        cutoff
      )
    ).toBe(false);
    expect(isExpiredStorageObject({ name: 'unknown' }, cutoff)).toBe(false);
  });

  it('falls back to updated_at', () => {
    expect(
      isExpiredStorageObject(
        { name: 'old', updated_at: '2026-07-01T00:00:00Z' },
        cutoff
      )
    ).toBe(true);
  });
});

/** `from(table).select().like(column, pattern).limit(1)` over fixed rows. */
function refsDb(rows: Record<string, Record<string, string>[]>, failTable?: string) {
  return {
    from(table: string) {
      let column = '';
      let suffix = '';
      const chain = {
        select: () => chain,
        like: (c: string, pattern: string) => {
          column = c;
          suffix = pattern.replace(/^%/, '');
          return chain;
        },
        limit: () =>
          Promise.resolve(
            table === failTable
              ? { data: null, error: new Error('down') }
              : {
                  data: (rows[table] ?? []).filter((r) => (r[column] ?? '').endsWith(suffix)),
                  error: null,
                },
          ),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe('isReferenced', () => {
  const path = 'account-1/123-photo.jpg';
  const url = `https://x.supabase.co/storage/v1/object/public/chat-media/${path}`;

  it('keeps media a message points at', async () => {
    expect(await isReferenced(refsDb({ messages: [{ id: 'm', media_url: url }] }), path)).toBe(true);
  });

  it('keeps a template header image (sends fall back to it)', async () => {
    expect(
      await isReferenced(refsDb({ message_templates: [{ id: 't', header_media_url: url }] }), path),
    ).toBe(true);
  });

  it('treats unreferenced media as orphaned', async () => {
    expect(await isReferenced(refsDb({}), path)).toBe(false);
  });

  it('throws rather than calling media orphaned when a lookup fails', async () => {
    await expect(isReferenced(refsDb({}, 'message_templates'), path)).rejects.toThrow('down');
  });
});
