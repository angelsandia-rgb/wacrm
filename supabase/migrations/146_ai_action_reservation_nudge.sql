-- ============================================================
-- 146_ai_action_reservation_nudge.sql — allow the auto-reply bot to
-- log its deterministic post-photo / post-confirm-attempt reservation
-- nudge (`ai_action_log.action = 'reservation_nudge'`, PR #186).
--
-- Same bug as migration 145 (send_stay_estimate) and 135 (send_photo),
-- found live again 2026-09-22: `sendReservationNudge` (auto-reply.ts)
-- has always inserted this action to dedupe an identical "me falta
-- las fechas..." nudge from repeating, but the CHECK constraint never
-- allowed it — every insert silently violated the constraint and was
-- swallowed by the caller's try/catch, so the dedupe guard never saw
-- a prior nudge and the exact same message kept firing on every photo
-- request, even for a reservation that already had every field.
--
-- Same idempotent widen as migrations 135/145.
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
      'auto_handoff_reservation_complete', 'send_stay_estimate', 'reservation_nudge'
    ]::text[])
  );
