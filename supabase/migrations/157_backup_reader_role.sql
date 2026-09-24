-- Dedicated read-only login for the VPS nightly backup
-- (scripts/backup/sandia-db-backup.sh, RUNBOOK §9), so the backup never
-- uses the `postgres` superuser password.
--
--   pg_read_all_data  SELECT on every table in every schema
--   BYPASSRLS         pg_dump refuses to dump RLS-protected tables otherwise
--   record_heartbeat  so the script can report `db_backup` ok/error
--
-- The PASSWORD is deliberately not in this file: it is generated on the
-- VPS (it never leaves it) and only its SCRAM-SHA-256 verifier is set in
-- the database, out of band:
--   alter role sandia_backup password 'SCRAM-SHA-256$4096:<salt>$<stored>:<server>';
-- Applied to production 2026-09-24.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'sandia_backup') then
    create role sandia_backup login bypassrls;
  end if;
end $$;
grant pg_read_all_data to sandia_backup;
grant execute on function public.record_heartbeat(text, text, text, integer) to sandia_backup;
alter role sandia_backup set statement_timeout = '15min';
