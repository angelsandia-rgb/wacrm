-- ============================================================
-- 145_ai_action_send_stay_estimate.sql — allow the auto-reply bot to
-- log its proactive stay-estimate follow-up
-- (`ai_action_log.action = 'send_stay_estimate'`, PR #178).
--
-- Real bug found live, 2026-09-20: `sendStayEstimateFollowUpIfDue`
-- (auto-reply.ts) has always inserted this action, but the CHECK
-- constraint never allowed it — every insert silently violated the
-- constraint and was swallowed by the caller's try/catch, so the
-- dedupe guard never saw a prior send and the same estimate got
-- re-sent to the guest on every turn that touched the reservation.
--
-- Same idempotent widen as migration 135 did for 'send_photo'.
-- ============================================================

ALTER TABLE public.ai_action_log
  DROP CONSTRAINT IF EXISTS ai_action_log_action_check;

ALTER TABLE public.ai_action_log
  ADD CONSTRAINT ai_action_log_action_check CHECK (
    action = ANY (ARRAY[
      'close_conversation', 'mark_deal_won', 'move_deal', 'set_lead_temperature',
      'create_quote', 'flag_deal_closing', 'create_deal', 'schedule_appointment',
      'create_automation_rule', 'send_quick_reply', 'record_reservation',
      'appointment_action', 'send_photo', 'send_category_banner',
      'auto_handoff_reservation_complete', 'send_stay_estimate'
    ]::text[])
  );
