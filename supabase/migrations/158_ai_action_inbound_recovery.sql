-- Allow ai_action_log.action = 'inbound_recovery' — the one-attempt claim
-- the inbound-recovery sweep (src/lib/ai/inbound-recovery.ts) writes before
-- re-dispatching a customer message whose AI reply was lost (e.g. to a
-- deploy restart mid-debounce). Without it the claim insert fails the
-- CHECK and the sweep skips every message (the 2026-09-20
-- send_stay_estimate failure mode). Same list as 146 plus the new value.

alter table public.ai_action_log drop constraint if exists ai_action_log_action_check;
alter table public.ai_action_log add constraint ai_action_log_action_check check (action = any (array[
  'close_conversation', 'mark_deal_won', 'move_deal', 'set_lead_temperature',
  'create_quote', 'flag_deal_closing', 'create_deal', 'schedule_appointment',
  'create_automation_rule', 'send_quick_reply', 'record_reservation',
  'appointment_action', 'send_photo', 'send_category_banner',
  'auto_handoff_reservation_complete', 'send_stay_estimate', 'reservation_nudge',
  'inbound_recovery'
]::text[]));
