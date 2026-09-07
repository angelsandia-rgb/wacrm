-- ============================================================
-- 118_conversation_ai_flow_directive.sql
--
-- A flow's `handoff` node can now hand a conversation to the AI
-- auto-reply bot instead of a human (HandoffNodeConfig.target = 'ai').
-- When it does, the node's `note` is written here as a one-shot
-- steering instruction: the next AI reply on this conversation is
-- generated with the note prepended to its system prompt ("the menu
-- routed this to you with this instruction — follow it"), then the
-- column is cleared.
--
-- Null = no pending directive (the overwhelming default).
-- Idempotent.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_flow_directive TEXT;

COMMENT ON COLUMN public.conversations.ai_flow_directive IS
  'One-shot instruction from a flow handoff-to-AI node (migration 118). Consumed + cleared by the next auto-reply generation.';
