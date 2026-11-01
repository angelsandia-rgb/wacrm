-- ============================================================
-- 169: AI close insights + auto-close (respond.io parity).
--   1. conversations: closed_at + AI category / summary / sentiment,
--      filled by /api/conversations/cron after a conversation closes.
--   2. A trigger stamps closed_at on every close path (inbox, AI action,
--      automation, auto-close) and clears the previous insights, so a
--      reopened-then-closed thread is analysed again.
--   3. conversation_close_config: one row per account (insights switch,
--      categories, auto-close after N days of inactivity).
--   4. ai_usage_log.mode allows 'close_insights'.
-- Idempotent.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS close_category text,
  ADD COLUMN IF NOT EXISTS close_summary text,
  ADD COLUMN IF NOT EXISTS close_sentiment text,
  ADD COLUMN IF NOT EXISTS close_sentiment_reason text,
  ADD COLUMN IF NOT EXISTS close_insights_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_close_sentiment_check') THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_close_sentiment_check
      CHECK (close_sentiment IS NULL OR close_sentiment IN ('positive', 'neutral', 'negative'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.stamp_conversation_closed()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    NEW.closed_at := now();
    NEW.close_insights_at := NULL;
    NEW.close_category := NULL;
    NEW.close_summary := NULL;
    NEW.close_sentiment := NULL;
    NEW.close_sentiment_reason := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_stamp_conversation_closed ON public.conversations;
CREATE TRIGGER trg_stamp_conversation_closed
  BEFORE UPDATE OF status ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_conversation_closed();

-- Sweep index: closed and not analysed yet.
CREATE INDEX IF NOT EXISTS idx_conversations_close_insights_pending
  ON public.conversations (account_id, closed_at)
  WHERE status = 'closed' AND close_insights_at IS NULL;

CREATE TABLE IF NOT EXISTS public.conversation_close_config (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  insights_enabled boolean NOT NULL DEFAULT false,
  categories text[] NOT NULL DEFAULT ARRAY['Consulta general', 'Ventas', 'Pago', 'Soporte', 'Otros'],
  auto_close_after_days integer CHECK (auto_close_after_days IS NULL OR auto_close_after_days BETWEEN 1 AND 90),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.conversation_close_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_close_config_select ON public.conversation_close_config;
DROP POLICY IF EXISTS conversation_close_config_insert ON public.conversation_close_config;
DROP POLICY IF EXISTS conversation_close_config_update ON public.conversation_close_config;
DROP POLICY IF EXISTS conversation_close_config_delete ON public.conversation_close_config;
CREATE POLICY conversation_close_config_select ON public.conversation_close_config
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY conversation_close_config_insert ON public.conversation_close_config
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY conversation_close_config_update ON public.conversation_close_config
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY conversation_close_config_delete ON public.conversation_close_config
  FOR DELETE USING (is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_close_config TO authenticated;
GRANT ALL ON public.conversation_close_config TO service_role;

ALTER TABLE public.ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE public.ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'assistant', 'close_insights'));
