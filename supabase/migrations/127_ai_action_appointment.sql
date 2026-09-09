-- ============================================================
-- 127_ai_action_appointment.sql — allow the clinic auto-reply bot to
-- log a patient's in-chat appointment confirm / cancel
-- (`ai_action_log.action = 'appointment_action'`).
--
-- Same idempotent widen as migration 113 did for 'record_reservation'.
-- ============================================================

ALTER TABLE public.ai_action_log
  DROP CONSTRAINT IF EXISTS ai_action_log_action_check;

ALTER TABLE public.ai_action_log
  ADD CONSTRAINT ai_action_log_action_check CHECK (
    action = ANY (ARRAY[
      'close_conversation', 'mark_deal_won', 'move_deal', 'set_lead_temperature',
      'create_quote', 'flag_deal_closing', 'create_deal', 'schedule_appointment',
      'create_automation_rule', 'send_quick_reply', 'record_reservation',
      'appointment_action'
    ]::text[])
  );
