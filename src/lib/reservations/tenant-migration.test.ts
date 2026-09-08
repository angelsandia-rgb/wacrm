import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Runs real PostgreSQL trigger code, independently of mocked API clients.
// Minimal fixture covers the columns referenced by migration 119.
const db = new PGlite()
const own = '00000000-0000-0000-0000-000000000001'
const foreign = '00000000-0000-0000-0000-000000000002'
let migration: string

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE contacts (id uuid PRIMARY KEY, account_id uuid NOT NULL);
    CREATE TABLE conversations (LIKE contacts INCLUDING ALL);
    CREATE TABLE products (LIKE contacts INCLUDING ALL);
    CREATE TABLE quotes (LIKE contacts INCLUDING ALL);
    CREATE TABLE product_rates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
      product_id uuid NOT NULL, day_of_week text NOT NULL, occupancy text NOT NULL,
      price numeric(12,2) NOT NULL, date_from date, date_to date
    );
    CREATE TABLE reservation_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
      contact_id uuid, conversation_id uuid, product_id uuid, quote_id uuid,
      check_in date, check_out date, use_date date, guests integer, duration_minutes integer,
      estimated_price numeric(12,2), created_at timestamptz DEFAULT now()
    );
  `)
  for (const table of ['contacts', 'conversations', 'products', 'quotes']) {
    await db.query(`INSERT INTO ${table} VALUES ($1, $1), ($2, $2)`, [own, foreign])
  }
  migration = await readFile(resolve('supabase/migrations/119_reservation_tenant_guard.sql'), 'utf8')
  await db.exec(migration)
}, 30_000)
afterAll(async () => { await db.close() })

describe('reservation SQL tenant guard', () => {
  for (const field of ['contact_id', 'conversation_id', 'product_id', 'quote_id']) {
    it(`rejects foreign ${field} on insert and update, accepts own references`, async () => {
      await expect(db.query(`INSERT INTO reservation_requests(account_id, ${field}) VALUES ($1, $2)`, [own, foreign]))
        .rejects.toMatchObject({ code: '23514' })
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO reservation_requests(account_id, ${field}) VALUES ($1, $1) RETURNING id`, [own],
      )
      await expect(db.query(`UPDATE reservation_requests SET ${field} = $1 WHERE id = $2`, [foreign, inserted.rows[0].id]))
        .rejects.toMatchObject({ code: '23514' })
      await db.query(`UPDATE reservation_requests SET ${field} = NULL WHERE id = $1`, [inserted.rows[0].id])
    })
  }
  it('validates the resulting date range on sparse updates', async () => {
    const inserted = await db.query<{ id: string }>(
      "INSERT INTO reservation_requests(account_id, check_in, check_out) VALUES ($1, '2026-09-09', '2026-09-11') RETURNING id", [own],
    )
    await expect(db.query("UPDATE reservation_requests SET check_out = '2026-09-08' WHERE id = $1", [inserted.rows[0].id]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(db.query('INSERT INTO reservation_requests(account_id, guests) VALUES ($1, 0)', [own]))
      .rejects.toMatchObject({ code: '23514' })
  })
  it('can run twice and does not grant public execution of the definer helper', async () => {
    await db.exec(migration)
    const { rows } = await db.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('authenticated', 'public.guard_reservation_tenant()', 'EXECUTE') AS allowed",
    )
    expect(rows[0].allowed).toBe(false)
  })
  it('guards product ownership and overlapping nightly rates', async () => {
    await expect(db.query(
      "INSERT INTO product_rates(account_id, product_id, day_of_week, occupancy, price) VALUES ($1, $2, 'mon', 'standard', 100)",
      [own, foreign],
    )).rejects.toMatchObject({ code: '23514' })
    await db.query(
      "INSERT INTO product_rates(account_id, product_id, day_of_week, occupancy, price, date_from, date_to) VALUES ($1, $1, 'mon', 'standard', 100, '2026-12-01', '2026-12-20')",
      [own],
    )
    await expect(db.query(
      "INSERT INTO product_rates(account_id, product_id, day_of_week, occupancy, price, date_from, date_to) VALUES ($1, $1, 'mon', 'standard', 150, '2026-12-20', '2026-12-31')",
      [own],
    )).rejects.toMatchObject({ code: '23505' })
    await db.query(
      "INSERT INTO product_rates(account_id, product_id, day_of_week, occupancy, price) VALUES ($1, $1, 'mon', 'standard', 80)",
      [own],
    )
    await expect(db.query(
      "INSERT INTO product_rates(account_id, product_id, day_of_week, occupancy, price) VALUES ($1, $1, 'mon', 'standard', 90)",
      [own],
    )).rejects.toMatchObject({ code: '23505' })
  })
})
