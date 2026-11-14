-- Durable, tenant-scoped order notifications. Only service_role may use this queue.
BEGIN;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS shopify_confirmation_decision TEXT
  CHECK (shopify_confirmation_decision IN ('confirm', 'cancel'));

CREATE TABLE IF NOT EXISTS public.shopify_notification_jobs (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, event_key)
);
ALTER TABLE public.shopify_notification_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shopify_notification_jobs FROM anon, authenticated;
GRANT ALL ON public.shopify_notification_jobs TO service_role;
CREATE INDEX IF NOT EXISTS shopify_notification_jobs_due ON public.shopify_notification_jobs(next_attempt_at)
  WHERE status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION public.claim_shopify_notification_jobs(
  p_account_id UUID DEFAULT NULL, p_event_key TEXT DEFAULT NULL
) RETURNS SETOF public.shopify_notification_jobs
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT account_id, event_key FROM public.shopify_notification_jobs
    WHERE status IN ('pending', 'processing') AND next_attempt_at <= now()
      AND (p_account_id IS NULL OR account_id = p_account_id)
      AND (p_event_key IS NULL OR event_key = p_event_key)
    ORDER BY next_attempt_at LIMIT 25 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.shopify_notification_jobs j
    SET status = 'processing', lease_token = gen_random_uuid(),
        next_attempt_at = now() + interval '10 minutes', attempts = attempts + 1
  FROM due WHERE j.account_id = due.account_id AND j.event_key = due.event_key
  RETURNING j.*;
$$;
REVOKE ALL ON FUNCTION public.claim_shopify_notification_jobs(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_shopify_notification_jobs(UUID, TEXT) TO service_role;

-- Commit a customer's answer and every local effect together. The pending
-- job retries Shopify's idempotent tag mutations even after the local decision
-- stops confirmation reminders. A repeated answer cannot notify/pause twice.
CREATE OR REPLACE FUNCTION public.record_shopify_order_decision(
  p_account_id UUID, p_deal_id UUID, p_order_id TEXT, p_conversation_id UUID,
  p_decision TEXT, p_handoff_agent_id UUID DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deal public.deals%ROWTYPE;
  v_conversation public.conversations%ROWTYPE;
  v_stage_id UUID;
  v_stage_position INTEGER;
  v_current_position INTEGER;
  v_order_name TEXT;
  v_line TEXT;
  v_assigned BOOLEAN;
BEGIN
  IF p_decision NOT IN ('confirm', 'cancel') OR p_decision IS NULL THEN
    RAISE EXCEPTION 'Invalid Shopify order decision';
  END IF;
  SELECT * INTO v_deal FROM public.deals
    WHERE id = p_deal_id AND account_id = p_account_id AND shopify_order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shopify order deal not found'; END IF;
  SELECT * INTO v_conversation FROM public.conversations
    WHERE id = p_conversation_id AND account_id = p_account_id AND contact_id = v_deal.contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order conversation not found'; END IF;
  IF v_deal.shopify_confirmation_decision IS NOT NULL AND v_deal.shopify_confirmation_decision <> p_decision THEN
    RAISE EXCEPTION 'Shopify order already has a different decision';
  END IF;
  v_order_name := COALESCE(substring(v_deal.title FROM '#[0-9]+'), 'su pedido');
  v_line := CASE WHEN p_decision = 'confirm'
    THEN '✅ El cliente confirmó por WhatsApp el pedido ' || v_order_name || ' (contra entrega). Ya puede despacharse en Dropi.'
    ELSE '❌ El cliente NO confirma el pedido ' || v_order_name || ': cancélelo en Dropi y en Shopify antes de que se despache.' END;
  IF EXISTS (SELECT 1 FROM public.shopify_notification_jobs
    WHERE account_id = p_account_id AND event_key = p_order_id || ':decision') THEN
    RETURN v_line;
  END IF;
  IF v_deal.shopify_confirmation_decision IS NULL AND v_deal.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Shopify order deal is no longer open';
  END IF;

  IF p_decision = 'confirm' THEN
    SELECT id, position INTO v_stage_id, v_stage_position FROM public.pipeline_stages
      WHERE pipeline_id = v_deal.pipeline_id AND lower(trim(name)) = 'pedido creado' ORDER BY position LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shopify order stage not configured'; END IF;
    SELECT position INTO v_current_position FROM public.pipeline_stages WHERE id = v_deal.stage_id;
    -- Do not move an order backwards if shipping and confirmation raced.
    UPDATE public.deals SET shopify_confirmation_decision = p_decision,
      stage_id = CASE WHEN v_current_position IS NULL OR v_current_position <= v_stage_position THEN v_stage_id ELSE stage_id END
      WHERE id = p_deal_id AND account_id = p_account_id;
  ELSE
    IF v_conversation.assigned_agent_id IS NULL AND p_handoff_agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles
      WHERE account_id = p_account_id AND user_id = p_handoff_agent_id AND account_role IN ('owner', 'admin', 'agent')) THEN
      RAISE EXCEPTION 'Handoff agent is not a member of the account';
    END IF;
    UPDATE public.deals SET shopify_confirmation_decision = p_decision WHERE id = p_deal_id AND account_id = p_account_id;
    v_assigned := v_conversation.assigned_agent_id IS NOT NULL OR p_handoff_agent_id IS NOT NULL;
    UPDATE public.conversations SET ai_autoreply_disabled = true, ai_handoff_summary = v_line,
      ai_handoff_at = now(), ai_handoff_transient = NULL,
      assigned_agent_id = COALESCE(assigned_agent_id, p_handoff_agent_id)
      WHERE id = p_conversation_id AND account_id = p_account_id;
    INSERT INTO public.messages(conversation_id, sender_type, content_type, content_text, status)
      VALUES (p_conversation_id, 'bot', 'internal_note', v_line, 'sent');
  END IF;

  -- Assignment notifications retain the existing database trigger. When a
  -- cancellation stays unassigned, alert the same agent+ fallback audience.
  IF p_decision = 'confirm' OR NOT v_assigned THEN
    INSERT INTO public.notifications(account_id, user_id, type, conversation_id, title, body)
      SELECT p_account_id, user_id, 'ai_handoff', p_conversation_id,
        CASE WHEN p_decision = 'confirm' THEN 'Pedido ' || v_order_name || ' confirmado' ELSE 'Requiere atención: pedido ' || v_order_name END,
        v_line FROM public.profiles WHERE account_id = p_account_id
        AND (account_role IN ('owner', 'admin') OR (p_decision = 'cancel' AND account_role = 'agent'));
  ELSIF v_conversation.assigned_agent_id IS NOT NULL THEN
    -- Reassigning to the same person does not fire the assignment trigger.
    -- A new cancellation still needs an alert on an already-owned thread.
    INSERT INTO public.notifications(account_id, user_id, type, conversation_id, title, body)
      SELECT p_account_id, user_id, 'ai_handoff', p_conversation_id,
        'Cancelación solicitada: pedido ' || v_order_name, v_line
      FROM public.profiles WHERE account_id = p_account_id AND user_id = v_conversation.assigned_agent_id;
  END IF;
  INSERT INTO public.shopify_notification_jobs(account_id, event_key, payload)
    VALUES (p_account_id, p_order_id || ':decision', jsonb_build_object(
      'conversationId', p_conversation_id, 'text', '', 'template', NULL,
      'decision', jsonb_build_object('orderId', p_order_id, 'decision', p_decision)));
  RETURN v_line;
END;
$$;
REVOKE ALL ON FUNCTION public.record_shopify_order_decision(UUID, UUID, TEXT, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_shopify_order_decision(UUID, UUID, TEXT, UUID, TEXT, UUID) TO service_role;

-- Shared guard for both AI and manual chat orders. An ambiguous remote
-- result is never released automatically: an operator must reconcile Shopify.
CREATE TABLE IF NOT EXISTS public.shopify_order_attempts (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  attempt_token UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed', 'blocked')),
  order_id TEXT,
  order_name TEXT,
  draft BOOLEAN,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, conversation_id)
);
ALTER TABLE public.shopify_order_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shopify_order_attempts FROM anon, authenticated;
GRANT ALL ON public.shopify_order_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.claim_shopify_order_attempt(p_account_id UUID, p_conversation_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_attempt public.shopify_order_attempts%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = p_conversation_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'Order conversation not found';
  END IF;
  INSERT INTO public.shopify_order_attempts(account_id, conversation_id, attempt_token)
    VALUES (p_account_id, p_conversation_id, v_token) ON CONFLICT DO NOTHING;
  SELECT * INTO v_attempt FROM public.shopify_order_attempts
    WHERE account_id = p_account_id AND conversation_id = p_conversation_id FOR UPDATE;
  IF v_attempt.attempt_token = v_token OR v_attempt.status = 'failed'
    OR (v_attempt.status = 'succeeded' AND v_attempt.created_at < now() - interval '30 minutes') THEN
    UPDATE public.shopify_order_attempts SET attempt_token = v_token, status = 'processing',
      order_id = NULL, order_name = NULL, draft = NULL, last_error = NULL, created_at = now()
      WHERE account_id = p_account_id AND conversation_id = p_conversation_id;
    RETURN jsonb_build_object('acquired', true, 'token', v_token, 'status', 'processing');
  END IF;
  IF v_attempt.status = 'processing' AND v_attempt.created_at < now() - interval '10 minutes' THEN
    UPDATE public.shopify_order_attempts SET status = 'blocked',
      last_error = 'Previous attempt interrupted; reconcile Shopify before retrying'
      WHERE account_id = p_account_id AND conversation_id = p_conversation_id;
    v_attempt.status := 'blocked';
  END IF;
  RETURN jsonb_build_object('acquired', false, 'status', v_attempt.status,
    'orderId', v_attempt.order_id, 'orderName', v_attempt.order_name);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_shopify_order_attempt(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_shopify_order_attempt(UUID, UUID) TO service_role;
COMMIT;
