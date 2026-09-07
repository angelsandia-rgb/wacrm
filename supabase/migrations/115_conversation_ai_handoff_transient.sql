-- ============================================================
-- 115_conversation_ai_handoff_transient.sql — mark an AI handoff as
-- caused by a TRANSIENT fault (provider timeout, a stray marker, a
-- Google Calendar hiccup, the per-conversation reply cap) rather than a
-- real "the customer asked for a human" request.
--
-- `auto-reply.ts` sets this true on the transient handoff paths and
-- false/NULL on an explicit customer request. When the next inbound
-- lands on a conversation whose bot is paused, the flag is true, no
-- human has actually replied since `ai_handoff_at`, and a grace period
-- has passed, the dispatcher clears `ai_autoreply_disabled` and lets the
-- bot try again ONCE — so one blip no longer parks a working
-- conversation on a human forever. Consuming the recovery clears the
-- flag, so a second transient handoff still waits for a person.
--
-- Nullable, default NULL (= not a transient handoff / legacy rows).
-- Idempotent.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_transient BOOLEAN;

COMMENT ON COLUMN public.conversations.ai_handoff_transient IS
  'True when the current AI handoff was caused by a transient fault (migration 115) — the dispatcher may auto-recover the bot once after a grace period if no human replied. NULL/false = explicit handoff, no auto-recovery.';
