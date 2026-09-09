-- ============================================================
-- 120_reservation_active_build.sql — one WhatsApp thread may now hold
-- MORE THAN ONE reservation per category.
--
-- `uq_reservation_requests_conv_category` (migration 112) allowed exactly
-- one row per (conversation, category), so the AI `record_reservation`
-- upsert *overwrote* an earlier, already-complete booking whenever a
-- returning guest asked for a second stay in the same chat — wrong dates
-- and a stale `estimated_price` on the Google Sheet row.
--
-- `is_active_build` marks the single row the AI is currently filling in
-- for a (conversation, category). When the guest starts a separate
-- booking the app flips the current row to `is_active_build = false`
-- (kept, with its Sheet line and metrics contribution) and inserts a
-- fresh one. The uniqueness the upsert's concurrency path relies on is
-- preserved — but now only over the *active* row.
--
-- Existing rows: the old unique index guaranteed at most one per
-- (conversation, category), so back-filling every row to TRUE is
-- consistent with the new partial unique index.
-- Idempotent.
-- ============================================================

ALTER TABLE reservation_requests
  ADD COLUMN IF NOT EXISTS is_active_build BOOLEAN NOT NULL DEFAULT TRUE;

DROP INDEX IF EXISTS uq_reservation_requests_conv_category;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_requests_conv_category_active
  ON reservation_requests(conversation_id, category)
  WHERE is_active_build AND conversation_id IS NOT NULL;

-- Lists / lookups that only care about the row being built.
CREATE INDEX IF NOT EXISTS idx_reservation_requests_conv_active
  ON reservation_requests(conversation_id, category)
  WHERE is_active_build;
