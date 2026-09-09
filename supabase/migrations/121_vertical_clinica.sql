-- ============================================================
-- 121_vertical_clinica.sql — register the 'clinica' industry vertical.
--
-- Widens the `accounts.industry_vertical` CHECK (migration 105) to
-- accept 'clinica'. For now its starter kit in `src/lib/verticals/` is
-- the same no-op as 'generic' — a clinic account behaves exactly like a
-- generic one until the kit and per-vertical behaviour are built out.
--
-- Idempotent — drops the named constraint if present and re-adds it.
-- ============================================================

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_industry_vertical_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_industry_vertical_check
    CHECK (industry_vertical IN ('generic', 'hotel', 'clinica'));
