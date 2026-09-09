-- ============================================================
-- 123_clinic_appointments_visits.sql — Sandía Clínica, Fase 2 (2 de 2):
-- citas, su historial de cambios, visitas realizadas, versiones de
-- notas médicas y plantillas de nota.
--
-- Fuente de verdad de la agenda: `appointments` (Postgres). Google
-- Calendar es un espejo OPCIONAL — `google_event_id` guarda el id del
-- evento espejado, o NULL.
--
-- Fuente de verdad de "ingresos": `visits.amount` de visitas del
-- período (independiente de `deals` / `quotes`).
--
-- Depende de la migración 122 (patient_profiles, doctor_profiles,
-- clinic_doctor_scope). Idempotente.
-- ============================================================

-- ── enum de estado de cita ──────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointment_status') THEN
    CREATE TYPE appointment_status AS ENUM (
      'SCHEDULED', 'CONFIRMED', 'DECLINED', 'NO_RESPONSE',
      'RESCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'
    );
  END IF;
END $$;

-- ── appointments ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patient_profiles(id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES public.doctor_profiles(id) ON DELETE RESTRICT,
  -- the service (reuses the products catalogue). NULL tolerated so a
  -- generic "consulta" can be booked before the catalogue is set up.
  service_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  -- the WhatsApp/IG/FB conversation this was booked from, when any.
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,

  scheduled_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,

  status appointment_status NOT NULL DEFAULT 'SCHEDULED',
  -- confirmation lifecycle, independent of `status`:
  --   not_required — this appointment never needed confirming
  --   pending      — a confirmation was (or will be) requested
  --   confirmed / declined / no_response — the patient's reply
  -- KPI "tasa de confirmación" = confirmed / (everything except not_required).
  confirmation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (confirmation_status IN ('not_required', 'pending', 'confirmed', 'declined', 'no_response')),

  -- suggested from the service's price, editable per appointment.
  amount NUMERIC(12,2) CHECK (amount IS NULL OR amount >= 0),
  notes TEXT,

  -- optional Google Calendar mirror.
  google_event_id TEXT,
  -- ties the instances of a recurring series together (same uuid).
  recurrence_group_id UUID,

  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (ends_at > scheduled_at),
  CHECK (ends_at - scheduled_at <= INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_appointments_account_time
  ON public.appointments(account_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_account_status
  ON public.appointments(account_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_time
  ON public.appointments(account_id, doctor_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_time
  ON public.appointments(patient_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_conversation
  ON public.appointments(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_recurrence
  ON public.appointments(recurrence_group_id) WHERE recurrence_group_id IS NOT NULL;
-- the reminder/confirmation sweep's working set: upcoming, still open.
CREATE INDEX IF NOT EXISTS idx_appointments_sweep
  ON public.appointments(account_id, scheduled_at)
  WHERE status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED');

-- ── appointment_history (append-only) ───────────────────────
CREATE TABLE IF NOT EXISTS public.appointment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  previous_status appointment_status,
  new_status appointment_status,
  previous_scheduled_at TIMESTAMPTZ,
  new_scheduled_at TIMESTAMPTZ,
  reason TEXT,
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointment_history_appointment
  ON public.appointment_history(appointment_id, created_at);

-- ── visits (the clinical + financial record) ────────────────
CREATE TABLE IF NOT EXISTS public.visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patient_profiles(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES public.appointments(id) ON DELETE SET NULL,
  doctor_id UUID REFERENCES public.doctor_profiles(id) ON DELETE SET NULL,
  service_id UUID REFERENCES public.products(id) ON DELETE SET NULL,

  visit_date DATE NOT NULL,
  amount NUMERIC(12,2) CHECK (amount IS NULL OR amount >= 0),
  notes TEXT,
  observations TEXT,
  -- when the doctor recommends the patient come back (exact date).
  follow_up_date DATE,

  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visits_account_date
  ON public.visits(account_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_patient_date
  ON public.visits(patient_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visits_account_followup
  ON public.visits(account_id, follow_up_date)
  WHERE follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visits_doctor
  ON public.visits(account_id, doctor_id);

-- ── visit_note_revisions (append-only audit of medical notes) ─
CREATE TABLE IF NOT EXISTS public.visit_note_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  notes TEXT,
  observations TEXT,
  edited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visit_note_revisions_visit
  ON public.visit_note_revisions(visit_id, created_at);

-- ── note_templates ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.note_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_templates_account
  ON public.note_templates(account_id);

-- ── updated_at triggers ────────────────────────────────────
DROP TRIGGER IF EXISTS set_updated_at ON public.appointments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.visits;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.note_templates;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.note_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.appointments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visit_note_revisions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_templates        ENABLE ROW LEVEL SECURITY;

-- appointments: a member reads their account's, BUT a restricted doctor
-- only their own (clinic_doctor_scope). agent+ writes, same scope.
DROP POLICY IF EXISTS appointments_select ON public.appointments;
DROP POLICY IF EXISTS appointments_insert ON public.appointments;
DROP POLICY IF EXISTS appointments_update ON public.appointments;
DROP POLICY IF EXISTS appointments_delete ON public.appointments;
CREATE POLICY appointments_select ON public.appointments FOR SELECT
  USING (
    is_account_member(account_id)
    AND (clinic_doctor_scope(account_id) IS NULL OR doctor_id = clinic_doctor_scope(account_id))
  );
CREATE POLICY appointments_insert ON public.appointments FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (clinic_doctor_scope(account_id) IS NULL OR doctor_id = clinic_doctor_scope(account_id))
  );
CREATE POLICY appointments_update ON public.appointments FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND (clinic_doctor_scope(account_id) IS NULL OR doctor_id = clinic_doctor_scope(account_id))
  );
CREATE POLICY appointments_delete ON public.appointments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- appointment_history: read follows the same doctor scope (via the
-- parent appointment); insert agent+; never update/delete (append-only).
DROP POLICY IF EXISTS appointment_history_select ON public.appointment_history;
DROP POLICY IF EXISTS appointment_history_insert ON public.appointment_history;
CREATE POLICY appointment_history_select ON public.appointment_history FOR SELECT
  USING (
    is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM public.appointments a
      WHERE a.id = appointment_history.appointment_id
        AND (clinic_doctor_scope(account_id) IS NULL OR a.doctor_id = clinic_doctor_scope(account_id))
    )
  );
CREATE POLICY appointment_history_insert ON public.appointment_history FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- visits: same doctor scope on read; agent+ writes.
DROP POLICY IF EXISTS visits_select ON public.visits;
DROP POLICY IF EXISTS visits_insert ON public.visits;
DROP POLICY IF EXISTS visits_update ON public.visits;
DROP POLICY IF EXISTS visits_delete ON public.visits;
CREATE POLICY visits_select ON public.visits FOR SELECT
  USING (
    is_account_member(account_id)
    AND (
      clinic_doctor_scope(account_id) IS NULL
      OR doctor_id = clinic_doctor_scope(account_id)
      OR doctor_id IS NULL
    )
  );
CREATE POLICY visits_insert ON public.visits FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY visits_update ON public.visits FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY visits_delete ON public.visits FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- visit_note_revisions: append-only; read follows the visit's scope.
DROP POLICY IF EXISTS visit_note_revisions_select ON public.visit_note_revisions;
DROP POLICY IF EXISTS visit_note_revisions_insert ON public.visit_note_revisions;
CREATE POLICY visit_note_revisions_select ON public.visit_note_revisions FOR SELECT
  USING (
    is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM public.visits v
      WHERE v.id = visit_note_revisions.visit_id
        AND (clinic_doctor_scope(account_id) IS NULL
             OR v.doctor_id = clinic_doctor_scope(account_id)
             OR v.doctor_id IS NULL)
    )
  );
CREATE POLICY visit_note_revisions_insert ON public.visit_note_revisions FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- note_templates: member reads; agent+ writes.
DROP POLICY IF EXISTS note_templates_select ON public.note_templates;
DROP POLICY IF EXISTS note_templates_write ON public.note_templates;
CREATE POLICY note_templates_select ON public.note_templates FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY note_templates_write ON public.note_templates FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointments         TO authenticated;
GRANT SELECT, INSERT                 ON public.appointment_history  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visits               TO authenticated;
GRANT SELECT, INSERT                 ON public.visit_note_revisions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_templates       TO authenticated;
GRANT ALL ON public.appointments         TO service_role;
GRANT ALL ON public.appointment_history  TO service_role;
GRANT ALL ON public.visits               TO service_role;
GRANT ALL ON public.visit_note_revisions TO service_role;
GRANT ALL ON public.note_templates       TO service_role;

-- ── Tenant guard for appointments / visits (RLS doesn't scope FKs) ──
CREATE OR REPLACE FUNCTION public.guard_clinic_appt_visit_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_patient UUID := NEW.patient_id;
  v_doctor  UUID := NEW.doctor_id;
  v_service UUID := NEW.service_id;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.patient_profiles
                 WHERE id = v_patient AND account_id = NEW.account_id) THEN
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
  IF TG_TABLE_NAME = 'appointments' AND NEW.conversation_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.conversations WHERE id = NEW.conversation_id AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'conversation_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_clinic_appt_visit_tenant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_tenant ON public.appointments;
CREATE TRIGGER guard_tenant BEFORE INSERT OR UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_appt_visit_tenant();
DROP TRIGGER IF EXISTS guard_tenant ON public.visits;
CREATE TRIGGER guard_tenant BEFORE INSERT OR UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_appt_visit_tenant();
