-- ============================================================
-- 178_shopify_cart_reminders.sql — one WhatsApp reminder per abandoned cart
--
-- src/lib/shopify/abandoned-carts.ts claims a Shopify abandoned checkout
-- here before messaging the customer, so a cart is reminded at most once
-- (primary key) even if the cron runs twice. `error` is null when sent.
-- Server-only (service role); RLS on with no policies. Additive, idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.shopify_cart_reminders (
  checkout_id TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  error TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopify_cart_reminders_account ON public.shopify_cart_reminders(account_id, sent_at DESC);

ALTER TABLE public.shopify_cart_reminders ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.shopify_cart_reminders TO service_role;
