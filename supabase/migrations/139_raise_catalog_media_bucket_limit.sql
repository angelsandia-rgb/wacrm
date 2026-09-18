-- ============================================================
-- 139_raise_catalog_media_bucket_limit.sql
--
-- `catalog-media` (migration 068) capped uploads at 10 MB — fine for
-- product photos, too small for a real restaurant menu PDF (Angel's
-- upload attempt, 2026-09-18: 27 MB, "MD SR HD.pdf"). WhatsApp's Cloud
-- API itself allows documents up to 100 MB; 10 MB was a
-- shared-hosting-UX choice, not a platform ceiling. Raised to 40 MB —
-- comfortable headroom over the immediate 27 MB file without opening
-- the door to anything WhatsApp would reject outright.
--
-- Idempotent (ON CONFLICT DO UPDATE, same as 068).
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'catalog-media',
  'catalog-media',
  TRUE,
  41943040, -- 40 MB
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  file_size_limit = EXCLUDED.file_size_limit;
