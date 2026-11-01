-- Deal stage history: one row each time a deal lands in a stage (on
-- create and on every stage_id change), written by a trigger so every
-- writer (board, AI, automations, API, hotel sync) is covered. Feeds the
-- /kpis pipeline funnel, which before this could only see the current stage.
-- Read-only to members; only the trigger writes.

CREATE TABLE IF NOT EXISTS public.deal_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  from_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_stage_history_deal_idx ON public.deal_stage_history (deal_id, changed_at);
CREATE INDEX IF NOT EXISTS deal_stage_history_account_idx ON public.deal_stage_history (account_id, changed_at);
CREATE INDEX IF NOT EXISTS deal_stage_history_from_stage_idx ON public.deal_stage_history (from_stage_id);
CREATE INDEX IF NOT EXISTS deal_stage_history_to_stage_idx ON public.deal_stage_history (to_stage_id);

ALTER TABLE public.deal_stage_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_stage_history_select ON public.deal_stage_history;
CREATE POLICY deal_stage_history_select ON public.deal_stage_history
  FOR SELECT USING (is_account_member(account_id));

GRANT SELECT ON public.deal_stage_history TO authenticated;
GRANT ALL ON public.deal_stage_history TO service_role;

CREATE OR REPLACE FUNCTION public.log_deal_stage_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO public.deal_stage_history (account_id, deal_id, from_stage_id, to_stage_id, changed_by)
    VALUES (
      NEW.account_id,
      NEW.id,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage_id END,
      NEW.stage_id,
      auth.uid()
    );
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.log_deal_stage_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_log_deal_stage_change ON public.deals;
CREATE TRIGGER trg_log_deal_stage_change
  AFTER INSERT OR UPDATE OF stage_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.log_deal_stage_change();
