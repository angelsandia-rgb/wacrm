-- ============================================================
-- 126_schedule_clinic_reminders_cron.sql — register the clinic
-- reminder sweep job.
--
-- Same shape as 100_schedule_followups_cron.sql: a pg_net GET with the
-- `x-cron-secret` header, on a 5-minute schedule. The sweep
-- (/api/clinic/reminders/cron) authenticates with
-- CLINIC_REMINDERS_CRON_SECRET and falls back to AUTOMATION_CRON_SECRET,
-- so you can reuse the secret already provisioned for the other cron
-- jobs and set nothing new.
--
-- SECRETS ARE NOT COMMITTED — run this in the Supabase SQL editor with
-- the two :'...' tokens replaced by literals, or with psql vars:
--
--   psql "$DATABASE_URL" \
--     -v base_url="https://your-app.example" \
--     -v cron_secret="$AUTOMATION_CRON_SECRET" \
--     -f supabase/migrations/126_schedule_clinic_reminders_cron.sql
--
-- Prereq: CLINIC_REMINDERS_CRON_SECRET (or AUTOMATION_CRON_SECRET) must
-- also be set in the app env (EasyPanel) or the endpoint returns 503.
-- Until this job is registered the `clinic_reminders_cron` heartbeat
-- reads "never" and the watchdog raises a warning — expected.
--
-- Idempotent: unschedule-then-schedule, safe to re-run.
-- ============================================================

\if :{?base_url}
\else
  \set base_url 'https://REPLACE_ME.example'
\endif
\if :{?cron_secret}
\else
  \set cron_secret 'REPLACE_ME_AUTOMATION_CRON_SECRET'
\endif

do $$ begin perform cron.unschedule('clinic-reminders-sweep'); exception when others then null; end $$;

select cron.schedule(
  'clinic-reminders-sweep',
  '*/5 * * * *',
  format(
    $job$select net.http_get(url := %L, headers := jsonb_build_object('x-cron-secret', %L), timeout_milliseconds := 8000);$job$,
    :'base_url' || '/api/clinic/reminders/cron', :'cron_secret'
  )
);
