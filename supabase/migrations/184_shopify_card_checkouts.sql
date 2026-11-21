-- 184_shopify_card_checkouts.sql — every card payment link the store issued.
--
-- Until now a Recurrente checkout was only known through its webhook: a lost
-- or never-delivered webhook meant real money with no order and nobody told.
-- Each link is recorded when it is created, so a reconciliation job can read
-- its state back from Recurrente and finish (or hold) the purchase even
-- without the webhook. Service role only; members can read their own.
-- Additive, idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.shopify_card_checkouts (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  checkout_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL,
  -- open: waiting to be paid. completed: the paid order exists. held: paid
  -- but not released (a person decides). expired: never paid.
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'held', 'expired')),
  order_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, checkout_id)
);
CREATE INDEX IF NOT EXISTS shopify_card_checkouts_open
  ON public.shopify_card_checkouts(created_at) WHERE status = 'open';

ALTER TABLE public.shopify_card_checkouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shopify_card_checkouts_member_read ON public.shopify_card_checkouts;
CREATE POLICY shopify_card_checkouts_member_read ON public.shopify_card_checkouts
  FOR SELECT TO authenticated USING (is_account_member(account_id, 'viewer'));
REVOKE ALL ON public.shopify_card_checkouts FROM anon, authenticated;
GRANT SELECT ON public.shopify_card_checkouts TO authenticated;
GRANT ALL ON public.shopify_card_checkouts TO service_role;

COMMIT;
