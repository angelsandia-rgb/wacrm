-- ============================================================
-- 176_shopify_recurrente_webhook.sql — auto-complete paid card orders
--
-- Svix signing secret (whsec_…) of the Recurrente webhook endpoint that
-- points at /api/shopify/recurrente-webhook?account=<id>. When a chat
-- card checkout is paid, that route completes the Shopify draft as a PAID
-- order (src/lib/shopify/api.ts, completePaidDraftOrder). AES-256-GCM
-- encrypted like the other secrets; null = drafts are completed by hand.
-- Additive, idempotent.
-- ============================================================

ALTER TABLE public.shopify_config ADD COLUMN IF NOT EXISTS recurrente_webhook_secret TEXT;
