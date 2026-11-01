import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Since 2026-10-30 Supabase no longer auto-grants Data API access on new
// public tables (see migration 168). A table created without a GRANT in
// the same migration is unreachable from supabase-js / PostgREST.
const DIR = resolve(__dirname, '../../../supabase/migrations')
const FIRST_CHECKED = 169

describe('migration grants', () => {
  it('every public table created after 168 is granted in the same file', () => {
    const missing: string[] = []
    for (const file of readdirSync(DIR)) {
      if (Number.parseInt(file, 10) < FIRST_CHECKED) continue
      const sql = readFileSync(resolve(DIR, file), 'utf8').replace(/--.*$/gm, '')
      const created = sql.matchAll(
        /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi,
      )
      for (const [, table] of created) {
        const granted = new RegExp(
          `grant\\s[^;]*\\bon\\s+(?:table\\s+)?(?:public\\.)?"?${table}"?\\b[^;]*\\bto\\b`,
          'i',
        )
        if (!granted.test(sql)) missing.push(`${file}: ${table}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('168 grants the production ACL on a fresh database', async () => {
    const db = new PGlite()
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.contacts (id int);
      create table public.rate_limit_buckets (id int);
      create table public.notifications (id int);
    `)
    await db.exec(readFileSync(resolve(DIR, '168_explicit_table_grants.sql'), 'utf8'))
    const { rows } = await db.query<{ t: string; r: string; p: string }>(`
      select table_name t, grantee r,
             string_agg(privilege_type, ',' order by privilege_type) p
      from information_schema.role_table_grants
      where grantee in ('anon','authenticated','service_role')
      group by 1, 2 order by 1, 2`)
    const all = 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
    expect(rows).toEqual([
      { t: 'contacts', r: 'anon', p: all },
      { t: 'contacts', r: 'authenticated', p: all },
      { t: 'contacts', r: 'service_role', p: all },
      { t: 'notifications', r: 'anon', p: all },
      { t: 'notifications', r: 'authenticated', p: 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE' },
      { t: 'notifications', r: 'service_role', p: all },
      { t: 'rate_limit_buckets', r: 'service_role', p: all },
    ])
    await db.close()
  }, 30_000) // PGlite boot is slow when the full suite runs in parallel.
})
