-- ============================================================
-- 116_account_catalog_slug_and_banner.sql
--
-- Two additions to the public catalog, both per-account scalars on
-- `accounts` (same convention as catalog_pdf_url / quote_delivery_mode /
-- restaurant_menu_url):
--
--   catalog_slug        — a short, human link for the public catalog.
--                         The page is served at BOTH /catalog/<uuid>
--                         (unchanged, always works) and the rewrite
--                         /c/<slug>. Unique, case-insensitive, lowercase
--                         [a-z0-9-]. Backfilled below from the account
--                         name so every existing account gets a short
--                         link immediately; editable in
--                         Products → "Entrega del catálogo".
--
--   catalog_banner_url  — the company's own banner/portada image, shown
--                         full-width at the top of the public catalog.
--                         Null = no banner (the page falls back to its
--                         auto "featured product" hero).
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS catalog_slug TEXT;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS catalog_banner_url TEXT;

-- Shape guard: lowercase, 3–40 chars, letters/digits/hyphen, no
-- leading/trailing/double hyphen. NULL is always allowed.
ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_catalog_slug_format;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_catalog_slug_format
  CHECK (
    catalog_slug IS NULL
    OR (
      catalog_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      AND char_length(catalog_slug) BETWEEN 3 AND 40
    )
  );

-- Backfill: derive a slug from the account name for every account that
-- doesn't have one yet, de-duplicating with a numeric suffix.
DO $$
DECLARE
  r RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR r IN SELECT id, name FROM public.accounts WHERE catalog_slug IS NULL LOOP
    base := lower(coalesce(r.name, ''));
    -- fold the common Spanish accents to ascii
    base := translate(base,
      'áàäâãéèëêíìïîóòöôõúùüûñç',
      'aaaaaeeeeiiiiooooouuuunc');
    base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
    base := regexp_replace(base, '(^-+|-+$)', '', 'g');
    base := left(base, 40);
    base := regexp_replace(base, '-+$', '', 'g');
    IF char_length(base) < 3 THEN
      base := 'catalogo';
    END IF;

    candidate := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM public.accounts WHERE lower(catalog_slug) = candidate
    ) LOOP
      n := n + 1;
      candidate := left(base, 36) || '-' || n::text;
    END LOOP;

    UPDATE public.accounts SET catalog_slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_catalog_slug_key
  ON public.accounts (lower(catalog_slug))
  WHERE catalog_slug IS NOT NULL;

COMMENT ON COLUMN public.accounts.catalog_slug IS
  'Short public-catalog handle (migration 116). Page served at /catalog/<uuid> and the /c/<slug> rewrite. Unique ci, lowercase [a-z0-9-].';
COMMENT ON COLUMN public.accounts.catalog_banner_url IS
  'URL of the company banner image shown at the top of the public catalog (migration 116). Null = no banner.';
