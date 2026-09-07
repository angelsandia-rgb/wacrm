-- ============================================================
-- 117_product_image_gallery.sql — up to 5 photos per product
--
-- `products` had a single `image_url` (migration 053). This adds a
-- `image_urls TEXT[]` gallery (max 5). `image_url` is KEPT and is now a
-- mirror of `image_urls[1]`, maintained by the write routes — every
-- existing reader (send-catalog, quote PDF, AI catalog context, the
-- public catalog hero) keeps working with no change.
--
-- Price options already had their own `image_urls` (migration 075);
-- that array is now capped at 5 in the shared parser too (no schema
-- change needed there).
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS image_urls TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_image_urls_max;
ALTER TABLE public.products
  ADD CONSTRAINT products_image_urls_max
  CHECK (array_length(image_urls, 1) IS NULL OR array_length(image_urls, 1) <= 5);

-- Seed the gallery from the existing single image for every product
-- that has one and no gallery yet.
UPDATE public.products
  SET image_urls = ARRAY[image_url]
  WHERE image_url IS NOT NULL
    AND btrim(image_url) <> ''
    AND (image_urls IS NULL OR array_length(image_urls, 1) IS NULL);

COMMENT ON COLUMN public.products.image_urls IS
  'Product photo gallery, max 5 (migration 117). image_url mirrors image_urls[1].';
