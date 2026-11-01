-- ============================================================
-- 173_shopify_integration.sql — Shopify store connection (per account)
--
-- One Shopify store per wacrm account, connected with a custom-app
-- Admin API access token the operator pastes in Settings → Shopify.
-- access_token / webhook_secret are AES-256-GCM encrypted with
-- src/lib/whatsapp/encryption.ts (ENCRYPTION_KEY), like every other
-- secret-at-rest here.
--
--   orders_live      — false (default): the AI creates Shopify DRAFT
--                      orders (nothing reaches Dropify/Dropi until a
--                      human completes the draft). true: real orders.
--   confirmation_template_* — WhatsApp template sent when a web-store
--                      order arrives via the orders/create webhook
--                      (body params: {{1}} name, {{2}} order, {{3}} total).
--
-- products.shopify_variant_id — sync key for "Sincronizar con Shopify".
-- deals.shopify_order_id      — idempotency for orders/create retries.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.shopify_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- audit-only
  shop_domain TEXT NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  access_token TEXT NOT NULL,       -- AES-256-GCM encrypted
  webhook_secret TEXT,              -- AES-256-GCM encrypted, HMAC key for orders/create
  orders_live BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_template_name TEXT,
  confirmation_template_language TEXT NOT NULL DEFAULT 'es',
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shopify_config_account ON public.shopify_config(account_id);
-- The webhook resolves the account from X-Shopify-Shop-Domain.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopify_config_shop ON public.shopify_config(shop_domain);

ALTER TABLE public.shopify_config ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON public.shopify_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.shopify_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Admin-only even for reads: the row carries (encrypted) store credentials.
DROP POLICY IF EXISTS shopify_config_select ON public.shopify_config;
DROP POLICY IF EXISTS shopify_config_insert ON public.shopify_config;
DROP POLICY IF EXISTS shopify_config_update ON public.shopify_config;
DROP POLICY IF EXISTS shopify_config_delete ON public.shopify_config;
CREATE POLICY shopify_config_select ON public.shopify_config FOR SELECT USING (is_account_member(account_id, 'admin'));
CREATE POLICY shopify_config_insert ON public.shopify_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY shopify_config_update ON public.shopify_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY shopify_config_delete ON public.shopify_config FOR DELETE USING (is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shopify_config TO authenticated;
GRANT ALL ON public.shopify_config TO service_role;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS shopify_variant_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_shopify_variant
  ON public.products(account_id, shopify_variant_id) WHERE shopify_variant_id IS NOT NULL;

ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS shopify_order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_shopify_order
  ON public.deals(account_id, shopify_order_id) WHERE shopify_order_id IS NOT NULL;

-- ai_action_log.action += 'create_shopify_order' (same list as 162 plus the new value).
alter table public.ai_action_log drop constraint if exists ai_action_log_action_check;
alter table public.ai_action_log add constraint ai_action_log_action_check check (action = any (array[
  'close_conversation', 'mark_deal_won', 'move_deal', 'set_lead_temperature',
  'create_quote', 'flag_deal_closing', 'create_deal', 'schedule_appointment',
  'create_automation_rule', 'send_quick_reply', 'record_reservation',
  'appointment_action', 'send_photo', 'send_category_banner',
  'auto_handoff_reservation_complete', 'send_stay_estimate', 'reservation_nudge',
  'inbound_recovery', 'set_contact_name', 'create_shopify_order'
]::text[]));
