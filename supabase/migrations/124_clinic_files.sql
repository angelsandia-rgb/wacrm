-- ============================================================
-- 124_clinic_files.sql — Sandía Clínica, Fase 7: archivos del paciente
-- / de la visita.
--
-- Documentos médicos — el bucket `clinic-files` es PRIVADO (a
-- diferencia de `catalog-media`, que es público): las descargas pasan
-- por URLs firmadas de corta vida que genera el servidor
-- (`GET /api/clinic-files/[id]/download`) tras verificar la cuenta.
--
-- `clinic_files` guarda los metadatos (nombre, tipo, tamaño, quién lo
-- subió) para poder listar sin recorrer Storage. Cada fila cuelga de un
-- paciente y/o de una visita (al menos uno).
--
-- Depende de las migraciones 122/123 (patient_profiles, visits).
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.clinic_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES public.patient_profiles(id) ON DELETE CASCADE,
  visit_id UUID REFERENCES public.visits(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (patient_id IS NOT NULL OR visit_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_clinic_files_patient ON public.clinic_files(patient_id);
CREATE INDEX IF NOT EXISTS idx_clinic_files_visit ON public.clinic_files(visit_id);
CREATE INDEX IF NOT EXISTS idx_clinic_files_account ON public.clinic_files(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clinic_files_path ON public.clinic_files(storage_path);

ALTER TABLE public.clinic_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clinic_files_select ON public.clinic_files;
DROP POLICY IF EXISTS clinic_files_insert ON public.clinic_files;
DROP POLICY IF EXISTS clinic_files_delete ON public.clinic_files;
CREATE POLICY clinic_files_select ON public.clinic_files FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY clinic_files_insert ON public.clinic_files FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY clinic_files_delete ON public.clinic_files FOR DELETE
  USING (is_account_member(account_id, 'agent'));

GRANT SELECT, INSERT, DELETE ON public.clinic_files TO authenticated;
GRANT ALL ON public.clinic_files TO service_role;

-- Tenant guard (RLS doesn't scope FKs).
CREATE OR REPLACE FUNCTION public.guard_clinic_file_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patient_profiles WHERE id = NEW.patient_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'patient_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  IF NEW.visit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.visits WHERE id = NEW.visit_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'visit_id belongs to another account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_clinic_file_tenant() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_tenant ON public.clinic_files;
CREATE TRIGGER guard_tenant BEFORE INSERT OR UPDATE ON public.clinic_files
  FOR EACH ROW EXECUTE FUNCTION public.guard_clinic_file_tenant();

-- ── private storage bucket ──────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'clinic-files',
  'clinic-files',
  FALSE,
  15728640, -- 15 MB
  ARRAY[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Path convention: account-<account_id>/<...>. Members of the account
-- may read / write / delete only under their own folder — no public
-- SELECT policy, so downloads must be signed URLs.
DROP POLICY IF EXISTS "Members read clinic files" ON storage.objects;
CREATE POLICY "Members read clinic files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'clinic-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members upload clinic files" ON storage.objects;
CREATE POLICY "Members upload clinic files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'clinic-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members delete clinic files" ON storage.objects;
CREATE POLICY "Members delete clinic files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'clinic-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
