-- ============================================================
-- 188_csat_moments.sql — the CSAT survey can go out at several moments
--
-- csat_config.moments: which moments send a survey and with which
-- approved template, e.g.
--   { "conversation_closed": { "template_name": "encuesta", "template_language": "es" },
--     "order_created":       { "template_name": "compra_facil", "template_language": "es" } }
-- Moments: deal_won | conversation_closed | order_created | order_delivered.
-- Empty = the original behaviour (deal_won with template_name).
--
-- csat_surveys.trigger: the moment that queued the row. source_key: the
-- per-moment dedupe key ("close:<conversation>:<closed_at>",
-- "order_created:<order gid>"…). One survey per won deal still holds,
-- but only for the deal_won moment.
--
-- Idempotent — safe to re-run. No new tables (grants unchanged).
-- ============================================================

ALTER TABLE public.csat_config
  ADD COLUMN IF NOT EXISTS moments JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.csat_surveys
  ADD COLUMN IF NOT EXISTS trigger TEXT NOT NULL DEFAULT 'deal_won';
ALTER TABLE public.csat_surveys
  ADD COLUMN IF NOT EXISTS source_key TEXT;

ALTER TABLE public.csat_surveys DROP CONSTRAINT IF EXISTS csat_surveys_trigger_check;
ALTER TABLE public.csat_surveys ADD CONSTRAINT csat_surveys_trigger_check
  CHECK (trigger IN ('deal_won', 'conversation_closed', 'order_created', 'order_delivered'));

DROP INDEX IF EXISTS public.uq_csat_surveys_deal;
CREATE UNIQUE INDEX IF NOT EXISTS uq_csat_surveys_deal
  ON public.csat_surveys (deal_id) WHERE deal_id IS NOT NULL AND trigger = 'deal_won';

CREATE UNIQUE INDEX IF NOT EXISTS uq_csat_surveys_source_key
  ON public.csat_surveys (account_id, source_key) WHERE source_key IS NOT NULL;
