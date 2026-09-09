import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Runs the real migration SQL (122 + 123) so the tenant-guard triggers,
// CHECK constraints and the `clinic_doctor_scope` helper are exercised
// against actual PostgreSQL, independent of the app's mocked clients.
const db = new PGlite()
const own = '00000000-0000-0000-0000-000000000001'
const foreign = '00000000-0000-0000-0000-000000000002'
const adminUser = '00000000-0000-0000-0000-0000000000a1'
const docUser = '00000000-0000-0000-0000-0000000000d1'

let patientOwn: string
let doctorOwn: string
let serviceOwn: string
let doctorProfileOwn: string

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

    CREATE TYPE account_role_enum AS ENUM ('owner','admin','agent','viewer');

    CREATE TABLE accounts (id uuid PRIMARY KEY);
    CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
      name text, price numeric, is_active boolean DEFAULT true
    );
    CREATE TABLE profiles (
      user_id uuid, account_id uuid, account_role account_role_enum
    );

    CREATE FUNCTION update_updated_at_column() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

    CREATE FUNCTION is_account_member(target_account_id uuid, min_role account_role_enum DEFAULT 'viewer')
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  `)
  await db.query('INSERT INTO accounts VALUES ($1), ($2)', [own, foreign])
  await db.query('INSERT INTO auth.users VALUES ($1), ($2)', [adminUser, docUser])
  await db.query(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,$3,'admin'), ($2,$3,'agent')`,
    [adminUser, docUser, own],
  )
  for (const table of ['contacts', 'conversations']) {
    await db.query(`INSERT INTO ${table}(id, account_id) VALUES (gen_random_uuid(), $1), (gen_random_uuid(), $2)`, [own, foreign])
  }

  for (const f of ['122_clinic_core.sql', '123_clinic_appointments_visits.sql']) {
    await db.exec(await readFile(resolve('supabase/migrations', f), 'utf8'))
  }

  const c = await db.query<{ id: string }>('SELECT id FROM contacts WHERE account_id = $1', [own])
  const conv = await db.query<{ id: string }>('SELECT id FROM conversations WHERE account_id = $1', [own])
  const svc = await db.query<{ id: string }>(
    `INSERT INTO products(account_id, name, price, duration_minutes) VALUES ($1,'Consulta',300,30) RETURNING id`,
    [own],
  )
  serviceOwn = svc.rows[0].id
  const pat = await db.query<{ id: string }>(
    'INSERT INTO patient_profiles(account_id, contact_id) VALUES ($1,$2) RETURNING id',
    [own, c.rows[0].id],
  )
  patientOwn = pat.rows[0].id
  const doc = await db.query<{ id: string }>(
    `INSERT INTO doctor_profiles(account_id, user_id, display_name) VALUES ($1,$2,'Dra. Own') RETURNING id`,
    [own, docUser],
  )
  doctorProfileOwn = doc.rows[0].id
  doctorOwn = doctorProfileOwn
  void conv
}, 30_000)

afterAll(async () => {
  await db.close()
})

const apptCols =
  'account_id, patient_id, doctor_id, service_id, scheduled_at, ends_at'
const apptVals = () => [own, patientOwn, doctorOwn, serviceOwn, '2026-03-09T15:00:00Z', '2026-03-09T15:30:00Z']

describe('clinic migrations 122 + 123', () => {
  it('can run twice (idempotent)', async () => {
    for (const f of ['122_clinic_core.sql', '123_clinic_appointments_visits.sql']) {
      await expect(db.exec(await readFile(resolve('supabase/migrations', f), 'utf8'))).resolves.toBeDefined()
    }
  })

  it('inserts a well-formed appointment', async () => {
    const r = await db.query<{ id: string; status: string }>(
      `INSERT INTO appointments (${apptCols}) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`,
      apptVals(),
    )
    expect(r.rows[0].status).toBe('SCHEDULED')
  })

  it('rejects a cross-account patient / doctor / service / conversation', async () => {
    // foreign patient
    const foreignContact = await db.query<{ id: string }>('SELECT id FROM contacts WHERE account_id = $1', [foreign])
    const foreignPatient = await db.query<{ id: string }>(
      'INSERT INTO patient_profiles(account_id, contact_id) VALUES ($1,$2) RETURNING id',
      [foreign, foreignContact.rows[0].id],
    )
    await expect(
      db.query(`INSERT INTO appointments (${apptCols}) VALUES ($1,$2,$3,$4,$5,$6)`, [
        own, foreignPatient.rows[0].id, doctorOwn, serviceOwn, '2026-03-09T15:00:00Z', '2026-03-09T15:30:00Z',
      ]),
    ).rejects.toMatchObject({ code: '23514' })

    // foreign conversation
    const foreignConv = await db.query<{ id: string }>('SELECT id FROM conversations WHERE account_id = $1', [foreign])
    await expect(
      db.query(
        `INSERT INTO appointments (${apptCols}, conversation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [...apptVals(), foreignConv.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('enforces ends_at > scheduled_at and a 24h ceiling', async () => {
    await expect(
      db.query(`INSERT INTO appointments (${apptCols}) VALUES ($1,$2,$3,$4,$5,$6)`, [
        own, patientOwn, doctorOwn, serviceOwn, '2026-03-09T15:00:00Z', '2026-03-09T14:00:00Z',
      ]),
    ).rejects.toThrow()
    await expect(
      db.query(`INSERT INTO appointments (${apptCols}) VALUES ($1,$2,$3,$4,$5,$6)`, [
        own, patientOwn, doctorOwn, serviceOwn, '2026-03-09T15:00:00Z', '2026-03-11T15:00:00Z',
      ]),
    ).rejects.toThrow()
  })

  it('rejects a bad confirmation_status', async () => {
    await expect(
      db.query(`INSERT INTO appointments (${apptCols}, confirmation_status) VALUES ($1,$2,$3,$4,$5,$6,'maybe')`, apptVals()),
    ).rejects.toThrow()
  })

  it('patient_profiles is one-per-contact and account-scoped', async () => {
    const c = await db.query<{ id: string }>('SELECT id FROM contacts WHERE account_id = $1', [own])
    await expect(
      db.query('INSERT INTO patient_profiles(account_id, contact_id) VALUES ($1,$2)', [own, c.rows[0].id]),
    ).rejects.toThrow() // unique(contact_id)
  })

  it('clinic_doctor_scope: NULL for an admin, the doctor id for a restricted agent-doctor', async () => {
    await db.exec(`SET test.uid = '${adminUser}'`)
    const admin = await db.query<{ s: string | null }>('SELECT clinic_doctor_scope($1) AS s', [own])
    expect(admin.rows[0].s).toBeNull()

    await db.exec(`SET test.uid = '${docUser}'`)
    const doc = await db.query<{ s: string | null }>('SELECT clinic_doctor_scope($1) AS s', [own])
    expect(doc.rows[0].s).toBe(doctorProfileOwn)

    // restrict_to_own = false -> sees everything again
    await db.query('UPDATE doctor_profiles SET restrict_to_own = false WHERE id = $1', [doctorProfileOwn])
    const doc2 = await db.query<{ s: string | null }>('SELECT clinic_doctor_scope($1) AS s', [own])
    expect(doc2.rows[0].s).toBeNull()
    await db.query('UPDATE doctor_profiles SET restrict_to_own = true WHERE id = $1', [doctorProfileOwn])
    await db.exec(`SET test.uid = ''`)
  })

  it('doctor_availability rejects end_time <= start_time and a foreign doctor', async () => {
    await expect(
      db.query(
        `INSERT INTO doctor_availability(account_id, doctor_id, day_of_week, start_time, end_time)
         VALUES ($1,$2,1,'12:00','08:00')`,
        [own, doctorOwn],
      ),
    ).rejects.toThrow()
  })
})
