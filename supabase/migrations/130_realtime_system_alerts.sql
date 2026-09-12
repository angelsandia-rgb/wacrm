-- ============================================================
-- 130_realtime_system_alerts.sql
--
-- The new /admin "Alertas" panel subscribes to `system_alerts` via
-- Supabase Realtime so a critical alert shows up without a manual
-- refresh. `system_alerts` already has an RLS SELECT policy scoped to
-- `is_platform_admin()` (migration 088) — that's the only access
-- control Realtime needs, since it replays postgres_changes through
-- the same RLS as any other read. The one thing missing is the table
-- being part of the `supabase_realtime` publication, same gap fixed
-- for deals/contacts in migration 059.
--
-- `ALTER PUBLICATION ... ADD TABLE` has no `IF NOT EXISTS` — wrapped
-- in a DO block that swallows the "already a member" error so this
-- stays safe to re-run.
-- ============================================================

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.system_alerts;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
