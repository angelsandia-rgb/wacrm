-- ============================================================
-- 140_product_rates_quad_occupancy.sql — hotel vertical: add a "quad"
-- (exactly 4 guests) occupancy tier to product_rates.
--
-- Angel's request, 2026-09-18: "habilita un precio para 4 personas
-- también en las habitaciones". Migration 108 widened occupancy to
-- standard | couple | group, where "group" meant "3+ guests" — now
-- "group" means exactly 3, and this adds "quad" for exactly 4.
-- 5+ guests deliberately gets no tier at all: `occupancyForGuests()`
-- (src/lib/products/rates.ts) returns null for 5+, so a stay that
-- large is never auto-priced — the request is always forwarded to a
-- person instead, never estimated.
--
-- Widening a CHECK never rewrites existing rows; no data migration.
-- Idempotent.
-- ============================================================

ALTER TABLE public.product_rates
  DROP CONSTRAINT IF EXISTS product_rates_occupancy_check;

ALTER TABLE public.product_rates
  ADD CONSTRAINT product_rates_occupancy_check
  CHECK (occupancy IN ('standard', 'couple', 'group', 'quad'));
