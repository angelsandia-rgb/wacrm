import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Proves the doctor-scope RLS end to end. Runs the real migration SQL
// (122–125 + 128 + 129) on PGlite, then queries as the non-superuser
// `authenticated` role so the RLS policies actually apply: a restricted
// doctor-user only sees / edits their own appointments & visits, while
// an admin sees everything. This is the security guarantee behind spec
// §22 / §30 ("the AI / a doctor can't reach data that isn't theirs").
const db = new PGlite()
const own = '00000000-0000-0000-0000-000000000001'
const foreign = '00000000-0000-0000-0000-000000000002'
const admin = '00000000-0000-0000-0000-0000000000a1'
const doc1 = '00000000-0000-0000-0000-0000000000d1'
const doc2 = '00000000-0000-0000-0000-0000000000d2'
const viewer = '00000000-0000-0000-0000-0000000000f1'

let dp1: string
let dp2: string
let patient: string
let patientOnlyDoc2: string
let ap1: string
let ap2: string
let ap3: string

/** Act as `uid` under the (non-superuser) `authenticated` role, so RLS
 *  policies actually apply. Superuser sessions bypass RLS entirely. */
async function asUser(uid: string) {
  await db.query('RESET ROLE')
  await db.query(`SET test.uid = '${uid}'`)
  await db.query('SET ROLE authenticated')
}
async function asSuper() {
  await db.query('RESET ROLE')
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role;
    GRANT USAGE ON SCHEMA public TO authenticated;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    CREATE SCHEMA extensions;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

    CREATE TYPE account_role_enum AS ENUM ('owner','admin','agent','viewer');
    CREATE TABLE accounts (id uuid PRIMARY KEY);
    CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
    CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text, price numeric);
    CREATE TABLE profiles (user_id uuid, account_id uuid, account_role account_role_enum);
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY, name text, public boolean, file_size_limit bigint,
      allowed_mime_types text[]
    );
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text
    );
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(path text) RETURNS text[] LANGUAGE sql IMMUTABLE
      AS $$ SELECT string_to_array(path, '/') $$;
    GRANT USAGE ON SCHEMA storage TO authenticated;
    GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated;

    CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

    -- a real-ish member check (mirrors migration 017)
    CREATE FUNCTION is_account_member(target_account_id uuid, min_role account_role_enum DEFAULT 'viewer')
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (
        SELECT 1 FROM profiles p
        WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
          AND (CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END)
              >= (CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END)
      );
    $$;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
    GRANT EXECUTE ON FUNCTION is_account_member(uuid, account_role_enum) TO authenticated;
  `)
  await db.query('INSERT INTO accounts VALUES ($1),($2)', [own, foreign])
  await db.query('INSERT INTO auth.users VALUES ($1),($2),($3),($4)', [admin, doc1, doc2, viewer])
  await db.query(
    `INSERT INTO profiles(user_id, account_id, account_role)
     VALUES ($1,$5,'admin'),($2,$5,'agent'),($3,$5,'agent'),($4,$5,'viewer')`,
    [admin, doc1, doc2, viewer, own],
  )
  await db.query(`INSERT INTO contacts(account_id) VALUES ($1)`, [own])
  await db.query(`INSERT INTO products(account_id, name, price) VALUES ($1,'Consulta',300)`, [own])

  for (const f of [
    '122_clinic_core.sql',
    '123_clinic_appointments_visits.sql',
    '124_clinic_files.sql',
    '125_clinic_reminder_tracking.sql',
    '128_fix_clinic_tenant_guard.sql',
  ]) {
    await db.exec(await readFile(resolve('supabase/migrations', f), 'utf8'))
  }
  const hardening = await readFile(
    resolve('supabase/migrations', '129_clinic_reliability_and_security.sql'),
    'utf8',
  )
  // PGlite does not bundle btree_gist. Execute every other statement from
  // the real migration here; the exclusion DDL is asserted separately.
  await db.exec(
    hardening.replace(
      /CREATE EXTENSION IF NOT EXISTS btree_gist[\s\S]*?RESET search_path;/,
      '',
    ),
  )

  // Seed as the superuser (bypasses RLS + has every privilege); the
  // test assertions below run as the non-superuser `authenticated` role
  // so the RLS policies actually apply.
  await asSuper()
  const c = await db.query<{ id: string }>('SELECT id FROM contacts WHERE account_id = $1', [own])
  const svc = await db.query<{ id: string }>('SELECT id FROM products WHERE account_id = $1', [own])
  const p = await db.query<{ id: string }>(
    'INSERT INTO patient_profiles(account_id, contact_id) VALUES ($1,$2) RETURNING id',
    [own, c.rows[0].id],
  )
  patient = p.rows[0].id
  const secondContact = await db.query<{ id: string }>(
    'INSERT INTO contacts(account_id) VALUES ($1) RETURNING id',
    [own],
  )
  const p2 = await db.query<{ id: string }>(
    'INSERT INTO patient_profiles(account_id, contact_id) VALUES ($1,$2) RETURNING id',
    [own, secondContact.rows[0].id],
  )
  patientOnlyDoc2 = p2.rows[0].id
  const d1 = await db.query<{ id: string }>(
    `INSERT INTO doctor_profiles(account_id, user_id, display_name, restrict_to_own) VALUES ($1,$2,'Dra. Uno',true) RETURNING id`,
    [own, doc1],
  )
  const d2 = await db.query<{ id: string }>(
    `INSERT INTO doctor_profiles(account_id, user_id, display_name, restrict_to_own) VALUES ($1,$2,'Dr. Dos',true) RETURNING id`,
    [own, doc2],
  )
  dp1 = d1.rows[0].id
  dp2 = d2.rows[0].id
  const a1 = await db.query<{ id: string }>(
    `INSERT INTO appointments(account_id, patient_id, doctor_id, service_id, scheduled_at, ends_at)
     VALUES ($1,$2,$3,$4,'2026-04-01T15:00:00Z','2026-04-01T15:30:00Z') RETURNING id`,
    [own, patient, dp1, svc.rows[0].id],
  )
  const a2 = await db.query<{ id: string }>(
    `INSERT INTO appointments(account_id, patient_id, doctor_id, service_id, scheduled_at, ends_at)
     VALUES ($1,$2,$3,$4,'2026-04-02T15:00:00Z','2026-04-02T15:30:00Z') RETURNING id`,
    [own, patient, dp2, svc.rows[0].id],
  )
  ap1 = a1.rows[0].id
  ap2 = a2.rows[0].id
  const a3 = await db.query<{ id: string }>(
    `INSERT INTO appointments(account_id, patient_id, doctor_id, service_id, scheduled_at, ends_at)
     VALUES ($1,$2,$3,$4,'2026-04-03T15:00:00Z','2026-04-03T15:30:00Z') RETURNING id`,
    [own, patientOnlyDoc2, dp2, svc.rows[0].id],
  )
  ap3 = a3.rows[0].id
  await db.query(
    `INSERT INTO visits(account_id, patient_id, doctor_id, visit_date, notes) VALUES
     ($1,$2,$3,'2026-03-01','nota de la Dra. Uno'), ($1,$2,$4,'2026-03-02','nota del Dr. Dos')`,
    [own, patient, dp1, dp2],
  )
  await db.query(
    `INSERT INTO clinic_files(account_id, patient_id, storage_path, filename)
     VALUES ($1,$2,$3,'private.pdf')`,
    [own, patientOnlyDoc2, `account-${own}/private.pdf`],
  )
  await db.query(
    `INSERT INTO storage.objects(bucket_id, name) VALUES ('clinic-files',$1)`,
    [`account-${own}/private.pdf`],
  )
  await asSuper()
}, 30_000)

afterAll(async () => {
  await db.close()
})

describe('clinic_doctor_scope RLS', () => {
  it('admin sees every appointment; each restricted doctor sees only their own', async () => {
    await asUser(admin)
    const all = await db.query('SELECT id FROM appointments WHERE account_id = $1', [own])
    expect(all.rows).toHaveLength(3)

    await asUser(doc1)
    const mine1 = await db.query<{ id: string }>('SELECT id FROM appointments WHERE account_id = $1', [own])
    expect(mine1.rows.map((r) => r.id)).toEqual([ap1])

    await asUser(doc2)
    const mine2 = await db.query<{ id: string }>('SELECT id FROM appointments WHERE account_id = $1', [own])
    expect(mine2.rows.map((r) => r.id)).toEqual([ap2, ap3])
  })

  it('a restricted doctor cannot update another doctor’s appointment', async () => {
    await asUser(doc1)
    const upd = await db.query(`UPDATE appointments SET notes = 'hack' WHERE id = $1`, [ap2])
    expect(upd.affectedRows ?? 0).toBe(0)
    // and can update their own
    const ok = await db.query(`UPDATE appointments SET notes = 'mine' WHERE id = $1`, [ap1])
    expect(ok.affectedRows).toBe(1)
  })

  it('visit notes are scoped the same way', async () => {
    await asUser(doc1)
    const v = await db.query<{ notes: string }>('SELECT notes FROM visits WHERE account_id = $1', [own])
    expect(v.rows.map((r) => r.notes)).toEqual(['nota de la Dra. Uno'])

    await asUser(admin)
    const all = await db.query('SELECT id FROM visits WHERE account_id = $1', [own])
    expect(all.rows).toHaveLength(2)
  })

  it('turning restrict_to_own off lifts the scope for that doctor', async () => {
    await asUser(admin)
    await db.query('UPDATE doctor_profiles SET restrict_to_own = false WHERE id = $1', [dp1])
    await asUser(doc1)
    const all = await db.query('SELECT id FROM appointments WHERE account_id = $1', [own])
    expect(all.rows).toHaveLength(3)
    // restore
    await asUser(admin)
    await db.query('UPDATE doctor_profiles SET restrict_to_own = true WHERE id = $1', [dp1])
    await asSuper()
  })

  it('hides unrelated patient profiles and files from a restricted doctor', async () => {
    await asUser(doc1)
    const patients = await db.query<{ id: string }>(
      'SELECT id FROM patient_profiles WHERE account_id = $1',
      [own],
    )
    expect(patients.rows.map((row) => row.id)).toEqual([patient])
    const files = await db.query('SELECT id FROM clinic_files WHERE account_id = $1', [own])
    expect(files.rows).toHaveLength(0)
    const objects = await db.query(
      `SELECT id FROM storage.objects WHERE bucket_id = 'clinic-files'`,
    )
    expect(objects.rows).toHaveLength(0)

    await asUser(doc2)
    const ownFiles = await db.query('SELECT id FROM clinic_files WHERE account_id = $1', [own])
    expect(ownFiles.rows).toHaveLength(1)
    const ownObjects = await db.query(
      `SELECT id FROM storage.objects WHERE bucket_id = 'clinic-files'`,
    )
    expect(ownObjects.rows).toHaveLength(1)
  })

  it('prevents a restricted doctor from creating or reassigning another doctor’s visit', async () => {
    await asUser(doc1)
    await expect(
      db.query(
        `INSERT INTO visits(account_id, patient_id, doctor_id, visit_date)
         VALUES ($1,$2,$3,'2026-03-03')`,
        [own, patient, dp2],
      ),
    ).rejects.toThrow()
    await expect(
      db.query('UPDATE visits SET doctor_id = $1 WHERE doctor_id = $2', [dp2, dp1]),
    ).rejects.toThrow()
  })

  it('rejects cross-tenant audit rows and a visit linked to another patient’s appointment', async () => {
    await asSuper()
    await expect(
      db.query(
        `INSERT INTO appointment_history(account_id, appointment_id, new_status)
         VALUES ($1,$2,'CONFIRMED')`,
        [foreign, ap1],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      db.query(
        `INSERT INTO visits(account_id, patient_id, appointment_id, doctor_id, visit_date)
         VALUES ($1,$2,$3,$4,'2026-03-04')`,
        [own, patientOnlyDoc2, ap1, dp2],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('replaces doctor availability atomically and preserves the old schedule on invalid input', async () => {
    await asUser(admin)
    const blocks = JSON.stringify([
      { day_of_week: 1, start_time: '08:00', end_time: '12:00' },
      { day_of_week: 3, start_time: '13:00', end_time: '17:00' },
    ])
    const replaced = await db.query<{ id: string }>(
      'SELECT id FROM replace_doctor_availability($1,$2,$3::jsonb)',
      [own, dp1, blocks],
    )
    expect(replaced.rows).toHaveLength(2)

    const invalid = JSON.stringify([
      { day_of_week: 4, start_time: '17:00', end_time: '08:00' },
    ])
    await expect(
      db.query('SELECT id FROM replace_doctor_availability($1,$2,$3::jsonb)', [
        own,
        dp1,
        invalid,
      ]),
    ).rejects.toThrow()

    const stillThere = await db.query<{ day_of_week: number }>(
      'SELECT day_of_week FROM doctor_availability WHERE account_id = $1 AND doctor_id = $2 ORDER BY day_of_week',
      [own, dp1],
    )
    expect(stillThere.rows.map((row) => row.day_of_week)).toEqual([1, 3])
    await asSuper()
  })

  it('does not let a viewer upload directly to the clinical bucket', async () => {
    await asUser(viewer)
    await expect(
      db.query(
        `INSERT INTO storage.objects(bucket_id, name)
         VALUES ('clinic-files',$1)`,
        [`account-${own}/viewer-upload.pdf`],
      ),
    ).rejects.toThrow()
    await asSuper()
  })
})
