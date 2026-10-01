-- Allow ai_action_log.action = 'set_contact_name'. autoSetContactName has
-- always logged it, but the value was never in the CHECK, so every insert
-- failed silently. Harmless until #228 made the hotel close read that log
-- (guestNameKnown) to know the guest stated their name: with no row, no
-- hotel request could close — the guest heard "le dejo solicitada", the
-- team got nothing, and the nudge asked for the name again (live QA
-- 2026-09-30). Same list as 158 plus the new value.

alter table public.ai_action_log drop constraint if exists ai_action_log_action_check;
alter table public.ai_action_log add constraint ai_action_log_action_check check (action = any (array[
  'close_conversation', 'mark_deal_won', 'move_deal', 'set_lead_temperature',
  'create_quote', 'flag_deal_closing', 'create_deal', 'schedule_appointment',
  'create_automation_rule', 'send_quick_reply', 'record_reservation',
  'appointment_action', 'send_photo', 'send_category_banner',
  'auto_handoff_reservation_complete', 'send_stay_estimate', 'reservation_nudge',
  'inbound_recovery', 'set_contact_name'
]::text[]));
