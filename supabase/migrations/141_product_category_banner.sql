-- ============================================================
-- 141_product_category_banner.sql — one banner image per catalog
-- category (hotel vertical only, for now).
--
-- Angel's request, 2026-09-18: when a guest asks about a category in
-- general ("qué habitaciones tienen", "precios de spa") rather than
-- one specific item, send that category's own banner image (photos +
-- prices, designed outside the CRM) instead of only a text reply.
-- Reuses the existing `catalog-media` bucket (migration 068/139) via
-- the same `uploadAccountMedia` helper products already use.
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.product_categories
  ADD COLUMN IF NOT EXISTS banner_url TEXT;
