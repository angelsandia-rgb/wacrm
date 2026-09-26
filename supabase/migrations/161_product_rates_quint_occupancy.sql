-- ============================================================
-- 161 — Hotel vertical: a "quint" (exactly 5 guests) occupancy tier.
--
-- Villa San Ricardo publishes a 5-person rate for the Junior Suite
-- Familiar (Q1,500 corporativa / Q1,800 recreativa); until now the tiers
-- stopped at 4 (migration 140) and 5 adults were quoted at the 4-person
-- rate, under-pricing the stay. A room without a quint rate keeps
-- treating 5 guests as too large to auto-price (src/lib/reservations/price.ts).
--
-- Widening a CHECK never rewrites existing rows. Idempotent.
-- ============================================================

ALTER TABLE public.product_rates
  DROP CONSTRAINT IF EXISTS product_rates_occupancy_check;

ALTER TABLE public.product_rates
  ADD CONSTRAINT product_rates_occupancy_check
  CHECK (occupancy IN ('standard', 'couple', 'group', 'quad', 'quint', 'child'));
