-- 185_shopify_purchase_attempts.sql — order creation is locked per PURCHASE.
--
-- claim_shopify_order_attempt (179) locks per conversation: one order per
-- chat every 30 minutes. That stops a re-emitted marker from ordering twice,
-- but it also refuses a second, intended purchase in the same chat.
-- Now each purchase has a key (a form request id, or the exact products,
-- quantities, phone and payment of a chat sale):
--   * the same purchase is never placed twice within 24 h;
--   * a different purchase in the same chat is allowed;
--   * an attempt whose outcome is unknown ('blocked') still quarantines the
--     whole conversation until a person checks Shopify, as before.
-- The old table and function stay (unused) for rollback.
-- Additive, idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.shopify_purchase_attempts (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  purchase_key TEXT NOT NULL,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  attempt_token UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed', 'blocked')),
  order_id TEXT,
  order_name TEXT,
  draft BOOLEAN,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, purchase_key)
);
CREATE INDEX IF NOT EXISTS shopify_purchase_attempts_conversation
  ON public.shopify_purchase_attempts(account_id, conversation_id, status);
ALTER TABLE public.shopify_purchase_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shopify_purchase_attempts FROM anon, authenticated;
GRANT ALL ON public.shopify_purchase_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.claim_shopify_purchase_attempt(
  p_account_id UUID, p_conversation_id UUID, p_purchase_key TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_attempt public.shopify_purchase_attempts%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = p_conversation_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'Order conversation not found';
  END IF;
  -- An interrupted creation anywhere in this chat: unknown result, so nothing
  -- new is placed here until a person reconciles Shopify.
  UPDATE public.shopify_purchase_attempts SET status = 'blocked',
    last_error = 'Previous attempt interrupted; reconcile Shopify before retrying'
    WHERE account_id = p_account_id AND conversation_id = p_conversation_id
      AND status = 'processing' AND created_at < now() - interval '10 minutes';
  IF EXISTS (SELECT 1 FROM public.shopify_purchase_attempts
    WHERE account_id = p_account_id AND conversation_id = p_conversation_id
      AND status = 'blocked' AND purchase_key <> p_purchase_key)
    -- An unresolved attempt from the previous per-chat lock counts too.
    OR EXISTS (SELECT 1 FROM public.shopify_order_attempts
      WHERE account_id = p_account_id AND conversation_id = p_conversation_id AND status = 'blocked') THEN
    RETURN jsonb_build_object('acquired', false, 'status', 'blocked');
  END IF;
  -- Transition: an order placed under the per-chat lock less than 30 min ago
  -- keeps that chat's old 30-minute duplicate window (a re-emitted marker
  -- right after the deploy must not order twice).
  IF EXISTS (SELECT 1 FROM public.shopify_order_attempts
    WHERE account_id = p_account_id AND conversation_id = p_conversation_id
      AND status IN ('succeeded', 'processing') AND created_at > now() - interval '30 minutes') THEN
    RETURN jsonb_build_object('acquired', false, 'status', 'succeeded');
  END IF;

  INSERT INTO public.shopify_purchase_attempts(account_id, purchase_key, conversation_id, attempt_token)
    VALUES (p_account_id, p_purchase_key, p_conversation_id, v_token) ON CONFLICT DO NOTHING;
  SELECT * INTO v_attempt FROM public.shopify_purchase_attempts
    WHERE account_id = p_account_id AND purchase_key = p_purchase_key FOR UPDATE;
  -- Ours (new), a failure before contacting Shopify, or the same purchase
  -- placed more than 24 h ago (a genuine repeat order) can start again.
  IF v_attempt.attempt_token = v_token OR v_attempt.status = 'failed'
    OR (v_attempt.status = 'succeeded' AND v_attempt.created_at < now() - interval '24 hours') THEN
    UPDATE public.shopify_purchase_attempts SET attempt_token = v_token, status = 'processing', conversation_id = p_conversation_id,
      order_id = NULL, order_name = NULL, draft = NULL, last_error = NULL, created_at = now()
      WHERE account_id = p_account_id AND purchase_key = p_purchase_key;
    RETURN jsonb_build_object('acquired', true, 'token', v_token, 'status', 'processing');
  END IF;
  RETURN jsonb_build_object('acquired', false, 'status', v_attempt.status,
    'orderId', v_attempt.order_id, 'orderName', v_attempt.order_name);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_shopify_purchase_attempt(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_shopify_purchase_attempt(UUID, UUID, TEXT) TO service_role;

COMMIT;
