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
COMMIT;
