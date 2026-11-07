-- ============================================================
-- 177_vertical_dropshipping.sql — register the 'dropshipping' industry vertical.
--
-- Widens the `accounts.industry_vertical` CHECK (migrations 105, 121) to
-- accept 'dropshipping' (tienda en línea con Shopify + Dropi). The kit
-- lives in `src/lib/verticals/index.ts`; selling is the Shopify
-- integration, gated by `shopify_config`, not by this value.
--
-- Idempotent — drops the named constraint if present and re-adds it.
-- ============================================================

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_industry_vertical_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_industry_vertical_check
    CHECK (industry_vertical IN ('generic', 'hotel', 'clinica', 'dropshipping'));
