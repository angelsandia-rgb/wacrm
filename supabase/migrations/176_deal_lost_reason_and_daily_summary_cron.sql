-- ============================================================
-- 176: Google Sheets P2.
--   1. deals.lost_reason / lost_at — the "Marcar como perdida" button
--      records why, and the new `deal.lost` event carries it to the
--      Sheet (<base> - Perdidas) and to webhooks.
--   2. Daily cron (06:15 UTC = 00:15 America/Guatemala) for the
--      `daily.summary` event (<base> - Resumen diario).
--      SECRETS ARE NOT COMMITTED: the job copies its x-cron-secret
--      header from the existing weekly-health job (same
--      SUBSCRIPTIONS_CRON_SECRET the route falls back to).
-- Idempotent.
-- ============================================================

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS lost_reason text CHECK (lost_reason IS NULL OR length(lost_reason) <= 500),
  ADD COLUMN IF NOT EXISTS lost_at timestamptz;

SELECT cron.unschedule('sheets-daily-summary')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sheets-daily-summary');

SELECT cron.schedule(
  'sheets-daily-summary',
  '15 6 * * *',
  replace(command, '/api/admin/weekly-health/cron', '/api/google-sheets/daily-summary/cron')
)
FROM cron.job WHERE jobname = 'weekly-health-email';

-- 3. Advisor fixes: evaluate auth.uid() once per statement in the
--    comment policies (migration 173) and cover two FKs.
DROP POLICY IF EXISTS conversation_comments_insert ON public.conversation_comments;
DROP POLICY IF EXISTS conversation_comments_delete ON public.conversation_comments;
CREATE POLICY conversation_comments_insert ON public.conversation_comments
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent') AND author_id = (SELECT auth.uid()));
CREATE POLICY conversation_comments_delete ON public.conversation_comments
  FOR DELETE USING (author_id = (SELECT auth.uid()) OR is_account_member(account_id, 'admin'));

CREATE INDEX IF NOT EXISTS conversation_close_config_created_by_idx ON public.conversation_close_config (created_by);
CREATE INDEX IF NOT EXISTS shopify_config_user_id_idx ON public.shopify_config (user_id);
