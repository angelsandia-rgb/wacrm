-- ============================================================
-- 189_response_sla.sql — response-time target ("plazo de respuesta")
--
-- When a customer's message sits unanswered (no teammate or bot reply):
--   alert_minutes     → push + in-app notice to the assignee (or assign
--                       the least-loaded online teammate when nobody has it)
--   escalate_minutes  → reassign to the least-loaded online teammate other
--                       than the current one (equitable), or notify the
--                       whole team when nobody else is online
--   ai_ack_minutes    → one safe acknowledgement from the bot (no prices,
--                       no promises), only if the AI may talk to that contact
-- The clock only runs inside the account's daily window (local time).
-- Off unless an account turns it on (no row = off).
--
-- response_sla_events: one row per stage per unanswered streak — the
-- claim that makes every stage fire exactly once (insert first, act after).
-- Run by /api/conversations/cron (every 5 min); no new cron job.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.response_sla_config (
  account_id        UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  alert_minutes     INTEGER NOT NULL DEFAULT 10 CHECK (alert_minutes BETWEEN 1 AND 1440),
  escalate_minutes  INTEGER NOT NULL DEFAULT 30 CHECK (escalate_minutes BETWEEN 1 AND 1440),
  -- NULL = the bot never sends the acknowledgement.
  ai_ack_minutes    INTEGER DEFAULT 60 CHECK (ai_ack_minutes IS NULL OR ai_ack_minutes BETWEEN 1 AND 1440),
  ack_text          TEXT NOT NULL DEFAULT 'Recibimos su mensaje. Un asesor le responde en breve.'
                      CHECK (char_length(ack_text) BETWEEN 1 AND 500),
  window_start_hour SMALLINT NOT NULL DEFAULT 8 CHECK (window_start_hour BETWEEN 0 AND 24),
  window_end_hour   SMALLINT NOT NULL DEFAULT 20 CHECK (window_end_hour BETWEEN 0 AND 24),
  created_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.response_sla_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS response_sla_config_select ON public.response_sla_config;
DROP POLICY IF EXISTS response_sla_config_write ON public.response_sla_config;
CREATE POLICY response_sla_config_select ON public.response_sla_config
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY response_sla_config_write ON public.response_sla_config
  FOR ALL USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.response_sla_config TO authenticated;
GRANT ALL ON public.response_sla_config TO service_role;

CREATE TABLE IF NOT EXISTS public.response_sla_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id   UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  -- First unanswered customer message of the streak (the clock's anchor).
  since_customer_at TIMESTAMPTZ NOT NULL,
  stage             TEXT NOT NULL CHECK (stage IN ('alert', 'escalate', 'ai_ack')),
  -- Who was notified / assigned (NULL = whole team, or the bot).
  target_user_id    UUID,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_response_sla_events_stage
  ON public.response_sla_events (conversation_id, since_customer_at, stage);
CREATE INDEX IF NOT EXISTS idx_response_sla_events_account_created
  ON public.response_sla_events (account_id, created_at DESC);

ALTER TABLE public.response_sla_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS response_sla_events_select ON public.response_sla_events;
CREATE POLICY response_sla_events_select ON public.response_sla_events
  FOR SELECT USING (is_account_member(account_id));
-- Writes: service role only (the cron sweep).
GRANT SELECT ON public.response_sla_events TO authenticated;
GRANT ALL ON public.response_sla_events TO service_role;

-- The notice type the sweep inserts (push fan-out fires on insert).
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'ai_key_invalid',
    'google_calendar_error',
    'google_sheets_error',
    'task_due',
    'ai_handoff',
    'mention',
    'response_sla'
  ));
