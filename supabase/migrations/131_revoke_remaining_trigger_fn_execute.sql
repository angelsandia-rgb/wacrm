-- ============================================================
-- 131_revoke_remaining_trigger_fn_execute.sql — close the same gap
-- migration 110 closed, for the two trigger functions it missed
--
-- `update_ai_knowledge_documents_updated_at()` (migration 030) and
-- `enforce_profile_privilege_columns()` (migration 034) are also
-- `SECURITY DEFINER` functions that RETURN trigger — same class as the
-- three the 110 already revoked. Found during the 2026-09-12 audit of
-- every SECURITY DEFINER function in supabase/migrations (see
-- docs/SANDIA_plan_de_desarrollo.md, entry 2026-09-12): not
-- exploitable (a trigger function invoked bare via RPC has no NEW/OLD
-- and errors), but there's no reason to leave them world-callable
-- either.
--
-- Same reasoning as 110: a trigger fires as part of its triggering
-- statement regardless of whether the invoking role holds EXECUTE on
-- the function, so this does NOT affect AI knowledge document
-- timestamps or the profile-privilege-column guard — it only removes
-- the RPC surface.
--
-- Idempotent (REVOKE of an absent grant is a harmless no-op).
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.update_ai_knowledge_documents_updated_at()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.enforce_profile_privilege_columns()
  FROM PUBLIC, anon, authenticated;
