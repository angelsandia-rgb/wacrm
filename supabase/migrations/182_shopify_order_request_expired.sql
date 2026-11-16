-- 182_shopify_order_request_expired.sql — unanswered form requests expire
-- visibly ('expired') after 72 h instead of silently aging out; the backlog
-- check (src/lib/shopify/backlog.ts) sets it and notifies owners/admins.
-- Additive, idempotent.
ALTER TABLE public.shopify_order_requests DROP CONSTRAINT IF EXISTS shopify_order_requests_status_check;
ALTER TABLE public.shopify_order_requests ADD CONSTRAINT shopify_order_requests_status_check
  CHECK (status IN ('pending','processing','confirmed','held','cancelled','superseded','expired'));
