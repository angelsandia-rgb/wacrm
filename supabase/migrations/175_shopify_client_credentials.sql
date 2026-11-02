-- ============================================================
-- 175_shopify_client_credentials.sql — Dev Dashboard apps (client credentials)
--
-- Shopify no longer lets stores create legacy custom apps with a static
-- shpat_ token; Dev Dashboard apps give a Client ID + Client secret and
-- the app trades them for a 24 h token (client_credentials grant,
-- src/lib/shopify/api.ts). When client_id is set, access_token holds the
-- cached grant token and access_token_expires_at its expiry; null client_id
-- = static token, never expires. client_secret is AES-256-GCM encrypted
-- like the other secrets and doubles as the webhook HMAC key fallback.
-- Additive, idempotent.
-- ============================================================

ALTER TABLE public.shopify_config ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE public.shopify_config ADD COLUMN IF NOT EXISTS client_secret TEXT;
ALTER TABLE public.shopify_config ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ;
