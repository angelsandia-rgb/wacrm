-- ============================================================
-- 173: Internal team comments on a conversation, with @mentions
-- (respond.io parity).
--   * Own table, NOT messages.content_type = 'internal_note': many
--     readers of `messages` (AI context, follow-up sweeper, KPIs,
--     response times) would otherwise count a teammate's comment as
--     an outbound turn.
--   * notifications.type allows 'mention'; the existing push fanout
--     trigger (migration 095) delivers it.
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.conversation_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_comments_conversation
  ON public.conversation_comments (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_comments_account
  ON public.conversation_comments (account_id);
CREATE INDEX IF NOT EXISTS idx_conversation_comments_author
  ON public.conversation_comments (author_id);

ALTER TABLE public.conversation_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_comments_select ON public.conversation_comments;
DROP POLICY IF EXISTS conversation_comments_insert ON public.conversation_comments;
DROP POLICY IF EXISTS conversation_comments_delete ON public.conversation_comments;
CREATE POLICY conversation_comments_select ON public.conversation_comments
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY conversation_comments_insert ON public.conversation_comments
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent') AND author_id = auth.uid());
CREATE POLICY conversation_comments_delete ON public.conversation_comments
  FOR DELETE USING (author_id = auth.uid() OR is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, DELETE ON public.conversation_comments TO authenticated;
GRANT ALL ON public.conversation_comments TO service_role;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversation_comments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_comments;
  END IF;
END $$;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'ai_key_invalid',
    'google_calendar_error',
    'google_sheets_error',
    'task_due',
    'ai_handoff',
    'mention'
  ));
