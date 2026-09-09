-- ============================================================
-- 128_fix_clinic_tenant_guard.sql — Sandía Clínica, Fase 11.
--
-- Bug fix. `guard_clinic_appt_visit_tenant` (migration 123) is one
-- trigger function shared by `appointments` and `visits`, and its body
-- referenced `NEW.conversation_id` directly. PL/pgSQL must PLAN that
-- field access against the row type even on the branch guarded by
-- `TG_TABLE_NAME = 'appointments'`, so any INSERT/UPDATE on `visits`
-- (which has no `conversation_id`) failed with
-- `record "new" has no field "conversation_id"`.
--
-- Fix: read every FK through `to_jsonb(NEW)->>'…'`, which yields NULL
-- for an absent key instead of failing to plan. Same checks, same
-- 23514 error codes.
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_clinic_appt_visit_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  v_patient UUID := (j->>'patient_id')::uuid;
  v_doctor  UUID := (j->>'doctor_id')::uuid;
  v_service UUID := (j->>'service_id')::uuid;
  v_conv    UUID := (j->>'conversation_id')::uuid;
BEGIN
  IF v_patient IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.patient_profiles WHERE id = v_patient AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'patient_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF v_doctor IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.doctor_profiles WHERE id = v_doctor AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'doctor_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF v_service IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.products WHERE id = v_service AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'service_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF v_conv IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.conversations WHERE id = v_conv AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'conversation_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_clinic_appt_visit_tenant() FROM PUBLIC, anon, authenticated;
