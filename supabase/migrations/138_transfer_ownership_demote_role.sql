-- ============================================================
-- 138_transfer_ownership_demote_role.sql
--
-- `transfer_account_ownership` always demoted the outgoing owner to
-- 'admin', with no way to land them somewhere else in one step (e.g.
-- a demo/setup account handed off to the real client, where the
-- original owner should end up as a plain 'agent' — Angel's explicit
-- request, 2026-09-17: "pixel5ilim@gmail.com sea solo de vendedor").
-- Getting there before required two calls: transfer (→ admin), then
-- set_member_role on... themselves, which set_member_role explicitly
-- refuses ("Cannot change your own role") — the outgoing owner can
-- never lower their own rank past what the transfer itself sets,
-- so there was no legitimate path to 'agent' at all without a
-- privileged direct UPDATE.
--
-- Adds an optional `p_demote_to_role` (default 'admin', so every
-- existing caller keeps today's behavior unless it opts in). Same
-- self-checking SECURITY DEFINER shape as before — only the
-- outgoing-owner UPDATE's role value changes.
--
-- Postgres treats a different argument list as a different function
-- overload, so this DROPs the 1-arg version first rather than
-- CREATE OR REPLACE, which cannot change a function's signature.
-- Idempotent — safe to re-run.
-- ============================================================

DROP FUNCTION IF EXISTS public.transfer_account_ownership(UUID);

CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID,
  p_demote_to_role account_role_enum DEFAULT 'admin'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_demote_to_role = 'owner' THEN
    RAISE EXCEPTION 'p_demote_to_role cannot be owner' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_new_owner_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Demote current owner first so the temporary state where the
  -- account has zero owners is never visible — both writes happen
  -- in the same function transaction.
  UPDATE profiles SET account_role = p_demote_to_role
  WHERE user_id = auth.uid();

  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id;

  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = v_caller_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID, account_role_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID, account_role_enum) TO authenticated;
