-- ============================================================
-- 122_clinic_core.sql — Sandía Clínica, Fase 2 (parte 1 de 2):
-- pacientes, doctores, disponibilidad, y el "scope" de un doctor.
--
-- Vertical `clinica` (migración 121). NADA de esto tiene efecto en
-- cuentas `generic` / `hotel` — son tablas nuevas, aisladas por
-- `account_id` + RLS, mismo patrón que `reservation_requests`.
--
--   - `products.duration_minutes` — un servicio médico dura X minutos
--     (el catálogo de Productos se reutiliza como "Servicios").
--   - `patient_profiles` — 1:1 con `contacts`. Delgada: los datos de
--     comunicación (teléfono, email, WhatsApp) viven en `contacts`.
--   - `doctor_profiles` — un doctor. `user_id` opcional: un doctor
--     puede no tener login. `restrict_to_own` limita a ESE usuario a
--     ver solo sus propias citas / visitas (admins/owners ven todo).
--   - `doctor_availability` — bloques horarios recurrentes por día de
--     la semana.
--   - `doctor_time_off` — vacaciones / días bloqueados / bloques
--     extraordinarios (un rango con override).
--   - `clinic_doctor_scope(account)` — el `doctor_profiles.id` al que
--     el usuario actual está limitado, o NULL si ve todo. Lo usan las
--     policies RLS de `appointments` / `visits` (migración 123).
--
-- Idempotente.
-- ============================================================

-- ── Servicios: duración ───────────────────────────────────────
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER
    CHECK (duration_minutes IS NULL OR (duration_minutes > 0 AND duration_minutes <= 1440));

COMMENT ON COLUMN public.products.duration_minutes IS
  'Clinic vertical (migration 122): default slot length in minutes for a service. NULL for non-clinic products.';

-- ── patient_profiles ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.patient_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  -- Where the patient originally came from. Free text, app-validated
  -- against a known set (WHATSAPP/FACEBOOK/INSTAGRAM/WEB/GOOGLE/
  -- REFERRAL/PHONE/OTHER); NULL when unknown.
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One patient profile per contact.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_profiles_contact
  ON public.patient_profiles(contact_id);
CREATE INDEX IF NOT EXISTS idx_patient_profiles_account
  ON public.patient_profiles(account_id);

-- ── doctor_profiles ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.doctor_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Optional: a doctor may not be a system user.
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  specialty TEXT,
  -- hex colour for the calendar; app-defaulted.
  color TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- When true AND this doctor is linked to a non-admin user, that user
  -- only sees their own appointments / visits (see clinic_doctor_scope).
  restrict_to_own BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A user is at most one doctor per account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_doctor_profiles_account_user
  ON public.doctor_profiles(account_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doctor_profiles_account
  ON public.doctor_profiles(account_id);

-- ── doctor_availability (recurring weekly blocks) ────────────
CREATE TABLE IF NOT EXISTS public.doctor_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES public.doctor_profiles(id) ON DELETE CASCADE,
  -- 0 = Sunday … 6 = Saturday (JS getDay()).
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL CHECK (end_time > start_time),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doctor_availability_doctor
  ON public.doctor_availability(account_id, doctor_id, day_of_week);

-- ── doctor_time_off (one-off overrides) ─────────────────────
CREATE TABLE IF NOT EXISTS public.doctor_time_off (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES public.doctor_profiles(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  reason TEXT,
  -- false = a blocked block (vacation / day off); true = an EXTRA
  -- working block outside the recurring availability.
  is_extra_hours BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doctor_time_off_doctor
  ON public.doctor_time_off(account_id, doctor_id, starts_at);

-- ── updated_at triggers ─────────────────────────────────────
DROP TRIGGER IF EXISTS set_updated_at ON public.patient_profiles;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.patient_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON public.doctor_profiles;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.doctor_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── clinic_doctor_scope: the doctor a user is limited to, or NULL ──
-- SECURITY DEFINER so RLS policy bodies can read profiles /
-- doctor_profiles without recursive RLS. Returns NULL (sees everything)
-- for admins/owners, for users with no doctor profile, and for doctor
-- profiles with restrict_to_own = false.
CREATE OR REPLACE FUNCTION public.clinic_doctor_scope(p_account_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.id
  FROM public.doctor_profiles d
  JOIN public.profiles p
    ON p.user_id = d.user_id AND p.account_id = d.account_id
  WHERE d.account_id = p_account_id
    AND d.user_id = auth.uid()
    AND d.restrict_to_own
    AND p.account_role IN ('agent', 'viewer')
  LIMIT 1;
$$;

ALTER FUNCTION public.clinic_doctor_scope(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clinic_doctor_scope(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clinic_doctor_scope(UUID) TO authenticated, service_role;

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE public.patient_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_time_off    ENABLE ROW LEVEL SECURITY;

-- patient_profiles: any member reads; agent+ writes.
DROP POLICY IF EXISTS patient_profiles_select ON public.patient_profiles;
DROP POLICY IF EXISTS patient_profiles_insert ON public.patient_profiles;
DROP POLICY IF EXISTS patient_profiles_update ON public.patient_profiles;
DROP POLICY IF EXISTS patient_profiles_delete ON public.patient_profiles;
CREATE POLICY patient_profiles_select ON public.patient_profiles FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY patient_profiles_insert ON public.patient_profiles FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY patient_profiles_update ON public.patient_profiles FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY patient_profiles_delete ON public.patient_profiles FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- doctor_profiles + availability + time off: any member reads; admin+ writes
-- (managing the clinic's roster / schedule is configuration, like WhatsApp
-- config — canEditSettings territory).
DROP POLICY IF EXISTS doctor_profiles_select ON public.doctor_profiles;
DROP POLICY IF EXISTS doctor_profiles_write ON public.doctor_profiles;
CREATE POLICY doctor_profiles_select ON public.doctor_profiles FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY doctor_profiles_write ON public.doctor_profiles FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS doctor_availability_select ON public.doctor_availability;
DROP POLICY IF EXISTS doctor_availability_write ON public.doctor_availability;
CREATE POLICY doctor_availability_select ON public.doctor_availability FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY doctor_availability_write ON public.doctor_availability FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS doctor_time_off_select ON public.doctor_time_off;
DROP POLICY IF EXISTS doctor_time_off_write ON public.doctor_time_off;
CREATE POLICY doctor_time_off_select ON public.doctor_time_off FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY doctor_time_off_write ON public.doctor_time_off FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_profiles   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.doctor_profiles    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.doctor_availability TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.doctor_time_off    TO authenticated;
GRANT ALL ON public.patient_profiles   TO service_role;
GRANT ALL ON public.doctor_profiles    TO service_role;
GRANT ALL ON public.doctor_availability TO service_role;
GRANT ALL ON public.doctor_time_off    TO service_role;

-- ── Tenant guard (defence in depth: RLS doesn't scope FKs) ───
CREATE OR REPLACE FUNCTION public.guard_clinic_child_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'patient_profiles' THEN
    IF NOT EXISTS (SELECT 1 FROM public.contacts
                   WHERE id = NEW.contact_id AND account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'patient_profiles.contact_id belongs to another account' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- doctor_availability / doctor_time_off
    IF NOT EXISTS (SELECT 1 FROM public.doctor_profiles
                   WHERE id = NEW.doctor_id AND account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'doctor_id belongs to another account' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_clinic_child_tenant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_tenant ON public.patient_profiles;
CREATE TRIGGER guard_tenant BEFORE INSERT OR UPDATE ON public.patient_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_child_tenant();
DROP TRIGGER IF EXISTS guard_tenant ON public.doctor_availability;
CREATE TRIGGER guard_tenant BEFORE INSERT OR UPDATE ON public.doctor_availability
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_child_tenant();
DROP TRIGGER IF EXISTS guard_tenant ON public.doctor_time_off;
CREATE TRIGGER guard_tenant BEFORE INSERT OR UPDATE ON public.doctor_time_off
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_child_tenant();
