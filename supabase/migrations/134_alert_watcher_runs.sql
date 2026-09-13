-- ============================================================
-- 134_alert_watcher_runs.sql
--
-- The "SANDIA alert watcher" (an hourly cloud routine, not app code)
-- reads open rows from `system_alerts`, investigates root cause in the
-- wacrm repo, and either opens a PR with a proposed fix or leaves a
-- diagnosis. This table is where it records that outcome so the
-- /admin "Alertas del sistema" panel can show it next to each alert
-- (PR link, what changed, whether tests passed) instead of that work
-- being invisible outside GitHub/push notifications.
--
-- One row per watcher run (not per alert) — an alert can only get one
-- run in practice today (the routine's own dedup skips an alert that
-- already has a PR), but modeling it as an append-only log instead of
-- a single mutable column on system_alerts keeps the watcher's writes
-- isolated to a table it owns, rather than mutating the alerts sink
-- every other write path treats as append/resolve-only.
--
-- `merged_at` is set by POST /api/admin/alerts/[id]/accept-fix (a
-- platform admin clicking "Aceptar"), which merges the PR via the
-- GitHub API — EasyPanel auto-deploys `main` on merge, so that click
-- is the "accept the proposed change" step. It stays NULL if the PR
-- was merged directly on GitHub instead of through that button.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.system_alert_watcher_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id      UUID NOT NULL REFERENCES public.system_alerts(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pr_opened', 'diagnosed_only')),
  branch        TEXT,
  pr_url        TEXT,
  summary       TEXT NOT NULL,
  tests_passed  BOOLEAN,
  merged_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_alert_watcher_runs_alert_recent
  ON public.system_alert_watcher_runs (alert_id, created_at DESC);

ALTER TABLE public.system_alert_watcher_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_alert_watcher_runs_select ON public.system_alert_watcher_runs;
CREATE POLICY system_alert_watcher_runs_select ON public.system_alert_watcher_runs
  FOR SELECT USING (public.is_platform_admin());
-- No INSERT/UPDATE/DELETE policy: the watcher routine writes via a
-- privileged Supabase connection (bypasses RLS, same as every other
-- service-role writer in this schema); the accept-fix endpoint updates
-- `merged_at` via platformAdminClient() (service role) for the same
-- reason.

REVOKE ALL ON TABLE public.system_alert_watcher_runs FROM anon;
GRANT SELECT ON TABLE public.system_alert_watcher_runs TO authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.system_alert_watcher_runs;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
