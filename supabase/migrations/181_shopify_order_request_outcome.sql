-- ============================================================
-- 181_shopify_order_request_outcome.sql — accepted terms + durable outcome
--
-- `terms`: what the customer accepted (variant ids, quantities, unit prices,
-- currency, total). The order is created only if the catalog still matches;
-- a price or item change is held for a person instead of charged.
-- `processing`: the customer said "sí" and creation started. It never goes
-- back to `pending`: it ends `confirmed` (order_id/order_name) or `held`
-- (outcome_note says why: not created, or the Shopify result is unknown) so a
-- person reconciles it instead of a second order being placed.
-- Additive, idempotent. Existing rows keep their status.
-- ============================================================

ALTER TABLE public.shopify_order_requests
  ADD COLUMN IF NOT EXISTS terms JSONB,
  ADD COLUMN IF NOT EXISTS order_id TEXT,
  ADD COLUMN IF NOT EXISTS order_name TEXT,
  ADD COLUMN IF NOT EXISTS outcome_note TEXT;

ALTER TABLE public.shopify_order_requests DROP CONSTRAINT IF EXISTS shopify_order_requests_status_check;
ALTER TABLE public.shopify_order_requests ADD CONSTRAINT shopify_order_requests_status_check
  CHECK (status IN ('pending', 'processing', 'confirmed', 'held', 'cancelled', 'superseded'));

-- Commercial shipping coverage per store: {"Guatemala": ["Mixco", ...], "Sacatepéquez": "*"}.
-- NULL = no restriction (every other company keeps its behavior). Checked when
-- a form request is made AND again before an order or payment link is created.
-- Apply BEFORE deploying: loadShopifyConfig selects this column.
ALTER TABLE public.shopify_config ADD COLUMN IF NOT EXISTS shipping_coverage JSONB;
