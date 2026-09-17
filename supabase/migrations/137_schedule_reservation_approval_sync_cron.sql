-- ============================================================
-- 137_schedule_reservation_approval_sync_cron.sql — register the
-- Sheets → CRM reservation-approval sync job.
--
-- Same shape as 100_schedule_followups_cron.sql: a pg_net GET with the
-- `x-cron-secret` header, on a 15-minute schedule (this reads out of
-- Google Sheets, gentler on quota than the 5-minute AI/automation
-- crons — a hotel staffer marking a cell doesn't need CRM-side
-- second-level latency). The sync (/api/google-sheets/
-- reservations-approval-sync/cron) authenticates with
-- RESERVATIONS_SYNC_CRON_SECRET and falls back to
-- AUTOMATION_CRON_SECRET, so you can reuse the secret already
-- provisioned for the automations/flows/followups jobs and set
-- nothing new.
--
-- SECRETS ARE NOT COMMITTED — run this in the Supabase SQL editor with
-- the two :'...' tokens replaced by literals, or with psql vars:
--
--   psql "$DATABASE_URL" \
--     -v base_url="https://your-app.example" \
--     -v cron_secret="$AUTOMATION_CRON_SECRET" \
--     -f supabase/migrations/137_schedule_reservation_approval_sync_cron.sql
--
-- Prereq: RESERVATIONS_SYNC_CRON_SECRET (or AUTOMATION_CRON_SECRET)
-- must also be set in the app env (EasyPanel) or the endpoint returns
-- 503 "cron not configured". Until this job is registered the
-- `reservation_approval_sync_cron` heartbeat reads "never" and the
-- heartbeat watchdog raises a (warning-level) "has never reported"
-- alert — expected.
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

do $$ begin perform cron.unschedule('reservation-approval-sync'); exception when others then null; end $$;

select cron.schedule(
  'reservation-approval-sync',
  '3-59/15 * * * *',
  format(
    $job$select net.http_get(url := %L, headers := jsonb_build_object('x-cron-secret', %L), timeout_milliseconds := 15000);$job$,
    :'base_url' || '/api/google-sheets/reservations-approval-sync/cron', :'cron_secret'
  )
);
