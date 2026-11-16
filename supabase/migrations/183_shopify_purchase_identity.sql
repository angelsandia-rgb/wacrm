-- 183_shopify_purchase_identity.sql — a purchase has its own identity.
--
-- Until now a form request was "the contact's pending request": a second
-- form superseded the first (two intended purchases could not coexist) and a
-- repeated submit created a second row. Now:
--   * purchase_id  — stable identity of one purchase, separate from the
--                    contact, the conversation and the wording of its summary;
--   * revision     — immutable versions of its terms: an edit closes the live
--                    revision ('superseded') and inserts the next one;
--   * idempotency_key — one row per submit intent, however often it is retried;
--   * ask_delivered_at — when the summary actually reached WhatsApp: only a
--                    delivered summary can be accepted.
-- The request and its WhatsApp question (the outbox job) are written in one
-- transaction by submit_shopify_order_request().
-- Additive, idempotent. Existing rows become revision 1 of their own purchase.
BEGIN;

ALTER TABLE public.shopify_order_requests
  ADD COLUMN IF NOT EXISTS purchase_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS ask_delivered_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS shopify_order_requests_idempotency
  ON public.shopify_order_requests(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shopify_order_requests_revision
  ON public.shopify_order_requests(purchase_id, revision);
-- At most one revision of a purchase can still be accepted or be in creation.
CREATE UNIQUE INDEX IF NOT EXISTS shopify_order_requests_live_revision
  ON public.shopify_order_requests(purchase_id) WHERE status IN ('pending', 'processing');

-- Requests from before this migration: delivered only if their question was sent.
UPDATE public.shopify_order_requests r SET ask_delivered_at = r.created_at
  WHERE r.ask_delivered_at IS NULL AND EXISTS (
    SELECT 1 FROM public.shopify_notification_jobs j
    WHERE j.account_id = r.account_id AND j.event_key = 'request:' || r.id || ':ask' AND j.status = 'sent');

CREATE OR REPLACE FUNCTION public.submit_shopify_order_request(
  p_account_id UUID, p_contact_id UUID, p_conversation_id UUID,
  p_proposal JSONB, p_total NUMERIC, p_currency TEXT, p_terms JSONB,
  p_idempotency_key TEXT, p_purchase_id UUID, p_job_payload JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.shopify_order_requests%ROWTYPE;
  v_live public.shopify_order_requests%ROWTYPE;
  v_purchase UUID := gen_random_uuid();
  v_revision INTEGER := 1;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversations
    WHERE id = p_conversation_id AND account_id = p_account_id AND contact_id = p_contact_id) THEN
    RAISE EXCEPTION 'Order conversation not found';
  END IF;

  -- A retry of the same submit returns the row it already created.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_row FROM public.shopify_order_requests
      WHERE account_id = p_account_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_row.id, 'purchaseId', v_row.purchase_id, 'revision', v_row.revision, 'created', false);
    END IF;
  END IF;

  -- An edit names the purchase it changes. Only a revision still waiting for
  -- the customer can be replaced: one in creation or already placed cannot.
  IF p_purchase_id IS NOT NULL THEN
    SELECT * INTO v_live FROM public.shopify_order_requests
      WHERE account_id = p_account_id AND contact_id = p_contact_id
        AND purchase_id = p_purchase_id AND status = 'pending' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase is not editable'; END IF;
    UPDATE public.shopify_order_requests SET status = 'superseded', decided_at = now() WHERE id = v_live.id;
    v_purchase := v_live.purchase_id;
    v_revision := v_live.revision + 1;
  END IF;

  INSERT INTO public.shopify_order_requests(
    account_id, contact_id, conversation_id, proposal, total, currency, terms, purchase_id, revision, idempotency_key)
    VALUES (p_account_id, p_contact_id, p_conversation_id, p_proposal, p_total, p_currency, p_terms,
      v_purchase, v_revision, p_idempotency_key)
    ON CONFLICT (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING * INTO v_row;
  IF NOT FOUND THEN
    -- A concurrent submit with the same key won: nothing of ours may remain,
    -- including the supersede above.
    RAISE EXCEPTION 'Concurrent submit' USING ERRCODE = '40001';
  END IF;

  -- The question for this revision, in the same transaction (outbox). The
  -- sender skips it once the revision is no longer pending.
  INSERT INTO public.shopify_notification_jobs(account_id, event_key, payload)
    VALUES (p_account_id, 'request:' || v_row.id || ':ask',
      p_job_payload || jsonb_build_object('request', jsonb_build_object('id', v_row.id)));

  RETURN jsonb_build_object('id', v_row.id, 'purchaseId', v_row.purchase_id, 'revision', v_row.revision, 'created', true);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_shopify_order_request(UUID, UUID, UUID, JSONB, NUMERIC, TEXT, JSONB, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_shopify_order_request(UUID, UUID, UUID, JSONB, NUMERIC, TEXT, JSONB, TEXT, UUID, JSONB) TO service_role;

COMMIT;
