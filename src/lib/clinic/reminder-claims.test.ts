import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Executes the real reminder-lease portion of migration 129. PGlite does
// not ship btree_gist, so this focused suite stops before the independent
// overlap-constraint section.
const db = new PGlite()
let appointmentId: string
let visitId: string
let migrationSql: string

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE appointments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT NOT NULL,
      confirmation_status TEXT NOT NULL,
      confirmation_reminder_sent_at TIMESTAMPTZ
    );
    CREATE TABLE visits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      follow_up_date DATE,
      follow_up_nudged_at TIMESTAMPTZ
    );
  `)
  migrationSql = await readFile(
    resolve('supabase/migrations/129_clinic_reliability_and_security.sql'),
    'utf8',
  )
  await db.exec(migrationSql.slice(0, migrationSql.indexOf('-- The application checks availability')))
  const appointment = await db.query<{ id: string }>(`
    INSERT INTO appointments(status, confirmation_status)
    VALUES ('SCHEDULED', 'pending') RETURNING id
  `)
  const visit = await db.query<{ id: string }>(`
    INSERT INTO visits(follow_up_date) VALUES (current_date) RETURNING id
  `)
  appointmentId = appointment.rows[0].id
  visitId = visit.rows[0].id
}, 30_000)

afterAll(async () => db.close())

describe('clinic reminder leases', () => {
  it('declares database-level overlap and one-visit-per-appointment guards', () => {
    expect(migrationSql).toContain('ADD CONSTRAINT appointments_no_doctor_overlap')
    expect(migrationSql).toContain("tstzrange(scheduled_at, ends_at, '[)') WITH &&")
    expect(migrationSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_visits_appointment')
  })

  it('lets only one worker claim an appointment and permits a failed send to be retried', async () => {
    const first = await db.query<{ claimed: boolean }>(
      `SELECT claim_clinic_confirmation_reminder($1, now(), now() - interval '15 minutes') AS claimed`,
      [appointmentId],
    )
    const concurrent = await db.query<{ claimed: boolean }>(
      `SELECT claim_clinic_confirmation_reminder($1, now(), now() - interval '15 minutes') AS claimed`,
      [appointmentId],
    )
    expect(first.rows[0].claimed).toBe(true)
    expect(concurrent.rows[0].claimed).toBe(false)

    await db.query(
      `UPDATE appointments SET confirmation_reminder_claimed_at = NULL,
       confirmation_reminder_last_error = 'provider timeout' WHERE id = $1`,
      [appointmentId],
    )
    const retry = await db.query<{ claimed: boolean }>(
      `SELECT claim_clinic_confirmation_reminder($1, now(), now() - interval '15 minutes') AS claimed`,
      [appointmentId],
    )
    expect(retry.rows[0].claimed).toBe(true)
  })

  it('does not reclaim a delivered reminder', async () => {
    await db.query(
      `UPDATE appointments SET confirmation_reminder_sent_at = now(),
       confirmation_reminder_claimed_at = NULL WHERE id = $1`,
      [appointmentId],
    )
    const claim = await db.query<{ claimed: boolean }>(
      `SELECT claim_clinic_confirmation_reminder($1, now(), now() - interval '15 minutes') AS claimed`,
      [appointmentId],
    )
    expect(claim.rows[0].claimed).toBe(false)
  })

  it('leases follow-ups and reclaims a stale worker', async () => {
    const first = await db.query<{ claimed: boolean }>(
      `SELECT claim_clinic_follow_up($1, now() - interval '30 minutes', now() - interval '15 minutes') AS claimed`,
      [visitId],
    )
    const reclaimed = await db.query<{ claimed: boolean }>(
      `SELECT claim_clinic_follow_up($1, now(), now() - interval '15 minutes') AS claimed`,
      [visitId],
    )
    expect(first.rows[0].claimed).toBe(true)
    expect(reclaimed.rows[0].claimed).toBe(true)
  })
})
