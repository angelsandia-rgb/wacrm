-- ============================================================
-- 133_stagger_five_minute_crons.sql
--
-- All 8 five-minute cron jobs (webhook-retry-sweep,
-- conversation-reassign-sweep, automations-pending-drain,
-- flows-timeout-sweep, heartbeat-staleness-check, task-reminders-sweep,
-- ai-followups-sweep, clinic-reminders-sweep) share the exact same
-- `*/5 * * * *` schedule — every one of them fires in the same instant,
-- every 5 minutes. On a 60-max-connections Postgres (this project's
-- tier), 8 concurrent cron-triggered requests — each doing its own
-- Supabase queries — compete for connections at the same moment.
--
-- Confirmed in net._http_response (2026-09-12, last 6h of retained
-- history): a sustained 20-35% failure rate across these jobs every
-- single hour — 8000ms pg_net timeouts and literal "Gateway Timeout"
-- responses from Supabase's own gateway, consistent with periodic
-- connection contention rather than one slow endpoint.
--
-- Fix: spread the 8 jobs across offsets within each 5-minute window
-- (minute-granularity is all cron gives us, so at most 5 distinct
-- offsets in a 5-minute span — still cuts peak concurrency from 8
-- jobs down to at most 2). Same total throughput, same 5-minute
-- cadence per job, just not all at once. Also raises their pg_net
-- timeout 8000ms -> 15000ms as a backstop, same reasoning as the
-- retention_cron fix (132) but a smaller bump since these run every
-- 5 minutes and must never risk overlapping their own next run.
--
-- Idempotent: unschedule-then-schedule per job, safe to re-run.
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  new_command text;
  offsets text[] := ARRAY[
    '0-59/5',  -- webhook-retry-sweep
    '1-59/5',  -- conversation-reassign-sweep
    '2-59/5',  -- automations-pending-drain
    '3-59/5',  -- flows-timeout-sweep
    '4-59/5',  -- heartbeat-staleness-check
    '0-59/5',  -- task-reminders-sweep (shares offset 0 with webhook-retry-sweep)
    '1-59/5',  -- ai-followups-sweep (shares offset 1 with conversation-reassign-sweep)
    '2-59/5'   -- clinic-reminders-sweep (shares offset 2 with automations-pending-drain)
  ];
  jobnames text[] := ARRAY[
    'webhook-retry-sweep',
    'conversation-reassign-sweep',
    'automations-pending-drain',
    'flows-timeout-sweep',
    'heartbeat-staleness-check',
    'task-reminders-sweep',
    'ai-followups-sweep',
    'clinic-reminders-sweep'
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(jobnames, 1) LOOP
    SELECT command INTO new_command FROM cron.job WHERE jobname = jobnames[i];
    IF new_command IS NULL THEN
      RAISE NOTICE 'skipping %: not found', jobnames[i];
      CONTINUE;
    END IF;
    new_command := replace(new_command, 'timeout_milliseconds := 8000', 'timeout_milliseconds := 15000');
    PERFORM cron.unschedule(jobnames[i]);
    PERFORM cron.schedule(jobnames[i], offsets[i] || ' * * * *', new_command);
  END LOOP;
END $$;
