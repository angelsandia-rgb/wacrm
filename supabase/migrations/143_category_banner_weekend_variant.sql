-- ============================================================
-- 143_category_banner_weekend_variant.sql
--
-- Angel's request, 2026-09-18: Villa San Ricardo has two rate tiers for
-- "Habitaciones" (corporate Sun-Thu vs recreational Fri-Sat) with a
-- separate banner image for each. The AI should ask for the stay's
-- date and pick the matching banner itself, instead of only ever
-- having one banner per category.
--
-- Also fixes a silent bug found while building this: 'send_photo'
-- (migration 135) never widened ai_action_log_action_check to include
-- 'send_category_banner' or 'auto_handoff_reservation_complete' —
-- every INSERT logging either action has been silently rejected by
-- the CHECK constraint since they shipped (the .insert() call sites
-- never check the returned error). No data was lost — this is an
-- audit-log gap, not a functional one — but it must be widened before
-- the new dedup guard below can rely on reading these rows back.
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.product_categories
  ADD COLUMN IF NOT EXISTS banner_url_weekend TEXT;

ALTER TABLE public.ai_action_log
  DROP CONSTRAINT IF EXISTS ai_action_log_action_check;

ALTER TABLE public.ai_action_log
  ADD CONSTRAINT ai_action_log_action_check CHECK (
    action = ANY (ARRAY[
      'close_conversation', 'mark_deal_won', 'move_deal', 'set_lead_temperature',
      'create_quote', 'flag_deal_closing', 'create_deal', 'schedule_appointment',
      'create_automation_rule', 'send_quick_reply', 'record_reservation',
      'appointment_action', 'send_photo', 'send_category_banner',
      'auto_handoff_reservation_complete'
    ]::text[])
  );
