-- ============================================================
-- 132_retention_cron_timeout.sql
--
-- `data-retention-sweep` (migration 092) was scheduled with the same
-- 8-second pg_net timeout as the 5-minute jobs. It's the wrong fit:
-- this one batches up to 1000 rows/table through `run_data_retention`
-- PLUS up to 200 Storage API deletes via `pruneOrphanedChatMedia` —
-- easily over 8s once there's any backlog. Confirmed in
-- `net._http_response`: the 2026-09-12 run hit
-- "Timeout of 8000 ms reached" before the route could finish, which
-- the heartbeat then correctly (if confusingly) recorded as an error.
--
-- This job runs once a day at 09:20 UTC, off-peak, alone — there is no
-- reason to keep it this tight. 60s gives the batched work real room
-- without risking two runs overlapping (it won't fire again for 24h).
--
-- Idempotent: unschedule-then-schedule, safe to re-run. Same
-- URL/secret as the existing job (read back from `cron.job`, not
-- re-typed) — nothing to configure by hand.
-- ============================================================

DO $$
DECLARE
  existing_command text;
  new_command text;
BEGIN
  SELECT command INTO existing_command
  FROM cron.job
  WHERE jobname = 'data-retention-sweep';

  IF existing_command IS NULL THEN
    RAISE EXCEPTION 'data-retention-sweep job not found — apply migration 092 first';
  END IF;

  new_command := replace(existing_command, 'timeout_milliseconds := 8000', 'timeout_milliseconds := 60000');

  PERFORM cron.unschedule('data-retention-sweep');
  PERFORM cron.schedule('data-retention-sweep', '20 9 * * *', new_command);
END $$;
