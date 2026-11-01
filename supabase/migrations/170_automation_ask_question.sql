-- ============================================================
-- 170: `ask_question` automation step (respond.io parity).
-- A run parked on a question waits in automation_pending_executions
-- with status 'awaiting_reply' until the customer answers (resumed from
-- the WhatsApp webhook) or `run_at` (the timeout) passes (resumed by
-- /api/automations/cron). Idempotent.
-- ============================================================

ALTER TABLE public.automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_status_check;
ALTER TABLE public.automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending', 'awaiting_reply', 'running', 'done', 'failed'));

-- The webhook looks up the open question for the contact that just wrote.
CREATE INDEX IF NOT EXISTS idx_automation_pending_awaiting_contact
  ON public.automation_pending_executions (contact_id, created_at)
  WHERE status = 'awaiting_reply';

-- The cron drains timeouts alongside due waits.
CREATE INDEX IF NOT EXISTS idx_automation_pending_awaiting_due
  ON public.automation_pending_executions (run_at)
  WHERE status = 'awaiting_reply';
