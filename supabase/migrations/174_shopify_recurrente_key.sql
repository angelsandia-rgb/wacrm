-- ============================================================
-- 174_shopify_recurrente_key.sql — Recurrente secret key for card links
--
-- When a chat customer pays by card, the AI sends a Recurrente hosted
-- checkout for the exact order total (src/lib/shopify/api.ts,
-- createRecurrenteCheckout). AES-256-GCM encrypted like the Shopify
-- token; null = no key, the chat hands off so an advisor sends the link.
-- Idempotent.
-- ============================================================

ALTER TABLE public.shopify_config ADD COLUMN IF NOT EXISTS recurrente_secret_key TEXT;
