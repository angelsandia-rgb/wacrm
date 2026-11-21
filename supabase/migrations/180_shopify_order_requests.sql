-- ============================================================
-- 180_shopify_order_requests.sql — web order requests awaiting WhatsApp
--
-- The store's own order form (/api/shopify/order-form) saves the request
-- here instead of creating a Shopify order: nothing reaches Shopify, and so
-- nothing reaches Dropify/Dropi, until the customer answers "sí" (cash on
-- delivery) or asks to pay by card (Recurrente link) on WhatsApp. The
-- `proposal` is the server-validated order (catalog names, quantities,
-- address) that is placed verbatim on confirmation — never re-read from
-- the model. One pending request per contact; a new one supersedes it.
-- Server-only (service role); members may read their account's rows.
-- Additive, idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.shopify_order_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  proposal JSONB NOT NULL,
  total NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GTQ',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shopify_order_requests_contact
  ON public.shopify_order_requests(account_id, contact_id, created_at DESC) WHERE status = 'pending';

ALTER TABLE public.shopify_order_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_order_requests_member_read ON public.shopify_order_requests;
CREATE POLICY shopify_order_requests_member_read ON public.shopify_order_requests
  FOR SELECT TO authenticated USING (is_account_member(account_id, 'viewer'));

GRANT SELECT ON public.shopify_order_requests TO authenticated;
GRANT ALL ON public.shopify_order_requests TO service_role;
