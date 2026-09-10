-- ============================================================
-- 129_clinic_reliability_and_security.sql
-- Reliability and tenant/privacy hardening for the clinic vertical.
-- Idempotent: safe to re-run.
-- ============================================================

-- A reminder needs a renewable claim separate from its delivered stamp.
-- Stamping `sent_at` before WhatsApp accepted the message permanently lost
-- reminders on any provider/network failure. A crashed worker may be
-- reclaimed after the lease expires.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS confirmation_reminder_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_reminder_last_error TEXT;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS follow_up_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS follow_up_last_error TEXT;

CREATE OR REPLACE FUNCTION public.claim_clinic_confirmation_reminder(
  p_appointment_id UUID,
  p_claimed_at TIMESTAMPTZ,
  p_stale_before TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.appointments
     SET confirmation_reminder_claimed_at = p_claimed_at,
         confirmation_reminder_last_error = NULL
   WHERE id = p_appointment_id
     AND confirmation_reminder_sent_at IS NULL
     AND confirmation_status = 'pending'
     AND status IN ('SCHEDULED', 'RESCHEDULED')
     AND (
       confirmation_reminder_claimed_at IS NULL
       OR confirmation_reminder_claimed_at < p_stale_before
     );
  RETURN FOUND;
END;
$$;

ALTER FUNCTION public.claim_clinic_confirmation_reminder(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.claim_clinic_follow_up(
  p_visit_id UUID,
  p_claimed_at TIMESTAMPTZ,
  p_stale_before TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.visits
     SET follow_up_claimed_at = p_claimed_at,
         follow_up_last_error = NULL
   WHERE id = p_visit_id
     AND follow_up_nudged_at IS NULL
     AND follow_up_date IS NOT NULL
     AND (
       follow_up_claimed_at IS NULL
       OR follow_up_claimed_at < p_stale_before
     );
  RETURN FOUND;
END;
$$;

ALTER FUNCTION public.claim_clinic_follow_up(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_clinic_confirmation_reminder(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_clinic_follow_up(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_clinic_confirmation_reminder(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_clinic_follow_up(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;

-- The application checks availability for a friendly conflict message, and
-- this database constraint closes the race between concurrent requests.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
SET search_path = public, extensions;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.appointments a
      JOIN public.appointments b
        ON a.id < b.id
       AND a.doctor_id = b.doctor_id
       AND tstzrange(a.scheduled_at, a.ends_at, '[)') &&
           tstzrange(b.scheduled_at, b.ends_at, '[)')
     WHERE a.status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_RESPONSE')
       AND b.status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_RESPONSE')
  ) THEN
    RAISE EXCEPTION 'Cannot install clinic overlap constraint: existing doctor appointments overlap'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.appointments'::regclass
       AND conname = 'appointments_no_doctor_overlap'
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_no_doctor_overlap
      EXCLUDE USING gist (
        doctor_id WITH =,
        tstzrange(scheduled_at, ends_at, '[)') WITH &&
      )
      WHERE (status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_RESPONSE'));
  END IF;
END;
$$;

RESET search_path;

-- One real-world consultation per appointment. This also makes a retry after
-- a partial request safe from creating a second clinical record.
CREATE UNIQUE INDEX IF NOT EXISTS uq_visits_appointment
  ON public.visits(appointment_id)
  WHERE appointment_id IS NOT NULL;

-- Resolve whether the caller may see a patient's clinical records. Admins,
-- owners and unrestricted staff get NULL doctor scope and can see the whole
-- account; a restricted doctor needs an appointment or visit of their own.
CREATE OR REPLACE FUNCTION public.clinic_can_access_patient(
  p_account_id UUID,
  p_patient_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_account_member(p_account_id)
     AND (
       public.clinic_doctor_scope(p_account_id) IS NULL
       OR EXISTS (
         SELECT 1 FROM public.appointments a
          WHERE a.account_id = p_account_id
            AND a.patient_id = p_patient_id
            AND a.doctor_id = public.clinic_doctor_scope(p_account_id)
       )
       OR EXISTS (
         SELECT 1 FROM public.visits v
          WHERE v.account_id = p_account_id
            AND v.patient_id = p_patient_id
            AND v.doctor_id = public.clinic_doctor_scope(p_account_id)
       )
     );
$$;

ALTER FUNCTION public.clinic_can_access_patient(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clinic_can_access_patient(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clinic_can_access_patient(UUID, UUID) TO authenticated, service_role;

-- Replacing a weekly schedule must be one transaction. The former API did
-- DELETE followed by INSERT, so a failed insert left the doctor with no
-- availability and made the clinic look fully booked.
CREATE OR REPLACE FUNCTION public.replace_doctor_availability(
  p_account_id UUID,
  p_doctor_id UUID,
  p_blocks JSONB
)
RETURNS SETOF public.doctor_availability
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.doctor_profiles
     WHERE id = p_doctor_id AND account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'doctor not found' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(p_blocks) <> 'array' OR jsonb_array_length(p_blocks) > 60 THEN
    RAISE EXCEPTION 'invalid availability blocks' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.doctor_availability
   WHERE account_id = p_account_id AND doctor_id = p_doctor_id;

  INSERT INTO public.doctor_availability(
    account_id, doctor_id, day_of_week, start_time, end_time
  )
  SELECT
    p_account_id,
    p_doctor_id,
    block.day_of_week,
    block.start_time,
    block.end_time
  FROM jsonb_to_recordset(p_blocks) AS block(
    day_of_week SMALLINT,
    start_time TIME,
    end_time TIME
  );

  RETURN QUERY
  SELECT availability.*
    FROM public.doctor_availability availability
   WHERE availability.account_id = p_account_id
     AND availability.doctor_id = p_doctor_id
   ORDER BY availability.day_of_week, availability.start_time;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_doctor_availability(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_doctor_availability(UUID, UUID, JSONB)
  TO authenticated, service_role;

DROP POLICY IF EXISTS patient_profiles_select ON public.patient_profiles;
CREATE POLICY patient_profiles_select ON public.patient_profiles FOR SELECT
  USING (public.clinic_can_access_patient(account_id, id));

DROP POLICY IF EXISTS visits_select ON public.visits;
DROP POLICY IF EXISTS visits_insert ON public.visits;
DROP POLICY IF EXISTS visits_update ON public.visits;
CREATE POLICY visits_select ON public.visits FOR SELECT
  USING (
    public.is_account_member(account_id)
    AND (
      public.clinic_doctor_scope(account_id) IS NULL
      OR doctor_id = public.clinic_doctor_scope(account_id)
    )
  );
CREATE POLICY visits_insert ON public.visits FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND (
      public.clinic_doctor_scope(account_id) IS NULL
      OR doctor_id = public.clinic_doctor_scope(account_id)
    )
  );
CREATE POLICY visits_update ON public.visits FOR UPDATE
  USING (
    public.is_account_member(account_id, 'agent')
    AND (
      public.clinic_doctor_scope(account_id) IS NULL
      OR doctor_id = public.clinic_doctor_scope(account_id)
    )
  )
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND (
      public.clinic_doctor_scope(account_id) IS NULL
      OR doctor_id = public.clinic_doctor_scope(account_id)
    )
  );

DROP POLICY IF EXISTS appointment_history_insert ON public.appointment_history;
CREATE POLICY appointment_history_insert ON public.appointment_history FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM public.appointments a
       WHERE a.id = appointment_history.appointment_id
         AND a.account_id = appointment_history.account_id
         AND (
           public.clinic_doctor_scope(appointment_history.account_id) IS NULL
           OR a.doctor_id = public.clinic_doctor_scope(appointment_history.account_id)
         )
    )
  );

DROP POLICY IF EXISTS visit_note_revisions_select ON public.visit_note_revisions;
DROP POLICY IF EXISTS visit_note_revisions_insert ON public.visit_note_revisions;
CREATE POLICY visit_note_revisions_select ON public.visit_note_revisions FOR SELECT
  USING (
    public.is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM public.visits v
       WHERE v.id = visit_note_revisions.visit_id
         AND v.account_id = visit_note_revisions.account_id
         AND (
           public.clinic_doctor_scope(visit_note_revisions.account_id) IS NULL
           OR v.doctor_id = public.clinic_doctor_scope(visit_note_revisions.account_id)
         )
    )
  );
CREATE POLICY visit_note_revisions_insert ON public.visit_note_revisions FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM public.visits v
       WHERE v.id = visit_note_revisions.visit_id
         AND v.account_id = visit_note_revisions.account_id
         AND (
           public.clinic_doctor_scope(visit_note_revisions.account_id) IS NULL
           OR v.doctor_id = public.clinic_doctor_scope(visit_note_revisions.account_id)
         )
    )
  );

-- RLS protects ordinary callers, and these triggers also protect service-role
-- jobs or future code paths that bypass RLS.
CREATE OR REPLACE FUNCTION public.guard_clinic_audit_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'appointment_history' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.appointments a
       WHERE a.id = NEW.appointment_id AND a.account_id = NEW.account_id
    ) THEN
      RAISE EXCEPTION 'appointment_id belongs to another account' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.visits v
       WHERE v.id = NEW.visit_id AND v.account_id = NEW.account_id
    ) THEN
      RAISE EXCEPTION 'visit_id belongs to another account' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_clinic_audit_tenant() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_clinic_audit_tenant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_tenant ON public.appointment_history;
CREATE TRIGGER guard_tenant BEFORE INSERT OR UPDATE ON public.appointment_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_audit_tenant();
DROP TRIGGER IF EXISTS guard_tenant ON public.visit_note_revisions;
CREATE TRIGGER guard_tenant BEFORE INSERT OR UPDATE ON public.visit_note_revisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_audit_tenant();

-- Add the missing visit->appointment ownership/patient check to the shared
-- appointments/visits trigger.
CREATE OR REPLACE FUNCTION public.guard_clinic_appt_visit_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  j             JSONB := to_jsonb(NEW);
  v_patient     UUID := (j->>'patient_id')::UUID;
  v_doctor      UUID := (j->>'doctor_id')::UUID;
  v_service     UUID := (j->>'service_id')::UUID;
  v_conv        UUID := (j->>'conversation_id')::UUID;
  v_appointment UUID := (j->>'appointment_id')::UUID;
BEGIN
  IF v_patient IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.patient_profiles
     WHERE id = v_patient AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'patient_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF v_doctor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.doctor_profiles
     WHERE id = v_doctor AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'doctor_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF v_service IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = v_service AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'service_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF v_conv IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.conversations
     WHERE id = v_conv AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'conversation_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF v_appointment IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.appointments
     WHERE id = v_appointment
       AND account_id = NEW.account_id
       AND patient_id = v_patient
  ) THEN
    RAISE EXCEPTION 'appointment_id belongs to another account or patient' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_clinic_appt_visit_tenant() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_clinic_appt_visit_tenant() FROM PUBLIC, anon, authenticated;

-- A file linked to both entities must belong to the visit's patient.
CREATE OR REPLACE FUNCTION public.guard_clinic_file_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patient_profiles
     WHERE id = NEW.patient_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'patient_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF NEW.visit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.visits
     WHERE id = NEW.visit_id
       AND account_id = NEW.account_id
       AND (NEW.patient_id IS NULL OR patient_id = NEW.patient_id)
  ) THEN
    RAISE EXCEPTION 'visit_id belongs to another account or patient' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_clinic_file_tenant() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_clinic_file_tenant() FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS clinic_files_select ON public.clinic_files;
DROP POLICY IF EXISTS clinic_files_insert ON public.clinic_files;
DROP POLICY IF EXISTS clinic_files_delete ON public.clinic_files;
CREATE POLICY clinic_files_select ON public.clinic_files FOR SELECT
  USING (
    public.is_account_member(account_id)
    AND (
      public.clinic_doctor_scope(account_id) IS NULL
      OR (patient_id IS NOT NULL AND public.clinic_can_access_patient(account_id, patient_id))
      OR EXISTS (
        SELECT 1 FROM public.visits v
         WHERE v.id = clinic_files.visit_id
           AND v.account_id = clinic_files.account_id
           AND v.doctor_id = public.clinic_doctor_scope(clinic_files.account_id)
      )
    )
  );
CREATE POLICY clinic_files_insert ON public.clinic_files FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND (
      public.clinic_doctor_scope(account_id) IS NULL
      OR (patient_id IS NOT NULL AND public.clinic_can_access_patient(account_id, patient_id))
      OR EXISTS (
        SELECT 1 FROM public.visits v
         WHERE v.id = clinic_files.visit_id
           AND v.account_id = clinic_files.account_id
           AND v.doctor_id = public.clinic_doctor_scope(clinic_files.account_id)
      )
    )
  );
CREATE POLICY clinic_files_delete ON public.clinic_files FOR DELETE
  USING (
    public.is_account_member(account_id, 'agent')
    AND (
      public.clinic_doctor_scope(account_id) IS NULL
      OR (patient_id IS NOT NULL AND public.clinic_can_access_patient(account_id, patient_id))
      OR EXISTS (
        SELECT 1 FROM public.visits v
         WHERE v.id = clinic_files.visit_id
           AND v.account_id = clinic_files.account_id
           AND v.doctor_id = public.clinic_doctor_scope(clinic_files.account_id)
      )
    )
  );

-- Storage follows the metadata row. A viewer can download an allowed file,
-- while only agent+ may upload/delete. A restricted doctor cannot bypass
-- metadata RLS by calling Storage directly with a guessed account path.
DROP POLICY IF EXISTS "Members read clinic files" ON storage.objects;
DROP POLICY IF EXISTS "Members upload clinic files" ON storage.objects;
DROP POLICY IF EXISTS "Members delete clinic files" ON storage.objects;

CREATE POLICY "Members read clinic files" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'clinic-files'
    AND EXISTS (
      SELECT 1 FROM public.clinic_files f
       WHERE f.storage_path = name
         AND public.is_account_member(f.account_id)
         AND (
           public.clinic_doctor_scope(f.account_id) IS NULL
           OR (f.patient_id IS NOT NULL AND public.clinic_can_access_patient(f.account_id, f.patient_id))
           OR EXISTS (
             SELECT 1 FROM public.visits v
              WHERE v.id = f.visit_id
                AND v.account_id = f.account_id
                AND v.doctor_id = public.clinic_doctor_scope(f.account_id)
           )
         )
    )
  );

CREATE POLICY "Members upload clinic files" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'clinic-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = auth.uid()
         AND p.account_role IN ('owner', 'admin', 'agent')
         AND ('account-' || p.account_id::TEXT) = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "Members delete clinic files" ON storage.objects FOR DELETE
  USING (
    bucket_id = 'clinic-files'
    AND EXISTS (
      SELECT 1 FROM public.clinic_files f
       WHERE f.storage_path = name
         AND public.is_account_member(f.account_id, 'agent')
         AND (
           public.clinic_doctor_scope(f.account_id) IS NULL
           OR (f.patient_id IS NOT NULL AND public.clinic_can_access_patient(f.account_id, f.patient_id))
           OR EXISTS (
             SELECT 1 FROM public.visits v
              WHERE v.id = f.visit_id
                AND v.account_id = f.account_id
                AND v.doctor_id = public.clinic_doctor_scope(f.account_id)
           )
         )
    )
  );
