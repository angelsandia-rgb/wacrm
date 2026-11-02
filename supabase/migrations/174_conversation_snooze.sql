-- ============================================================
-- 174: Snooze a conversation until a given time (respond.io parity).
--   * conversations.snoozed_until — the inbox hides the thread until
--     then; once it passes the thread simply shows again (no cron).
--   * A new customer message wakes it up immediately.
-- Idempotent.
-- ============================================================

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;

CREATE OR REPLACE FUNCTION public.wake_snoozed_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.conversations SET snoozed_until = NULL
    WHERE id = NEW.conversation_id AND snoozed_until IS NOT NULL;
  RETURN NULL;
END $$;

REVOKE EXECUTE ON FUNCTION public.wake_snoozed_conversation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_wake_snoozed_conversation ON public.messages;
CREATE TRIGGER trg_wake_snoozed_conversation
  AFTER INSERT ON public.messages
  FOR EACH ROW WHEN (NEW.sender_type = 'customer')
  EXECUTE FUNCTION public.wake_snoozed_conversation();
