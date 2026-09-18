-- ============================================================
-- 142_conversation_ai_context_reset.sql — let an agent reset a
-- conversation's AI memory back to zero.
--
-- Angel's request, 2026-09-18: a button to make a chat "start from
-- scratch" for the AI (forget prior context, send the welcome message
-- again) without touching the visible chat history or any real
-- business data (reservations, contact fields, lead temperature).
--
-- `ai_context_reset_at`: when set, `buildConversationContext` (the
-- function that feeds message history to the LLM) only includes
-- messages created after this timestamp. The chat transcript itself is
-- untouched — only what the AI is shown resets.
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_context_reset_at TIMESTAMPTZ;
