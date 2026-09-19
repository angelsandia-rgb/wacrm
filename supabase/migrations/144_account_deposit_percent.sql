-- ============================================================
-- 144_account_deposit_percent
--
-- Make the reservation deposit percentage configurable per account.
--
-- The hotel vertical's AI assistant computes a stay total from the
-- account's own published rates (`estimateStayPrice` / `quoteStay`,
-- migration 140+) but had no notion of a deposit at all — guests were
-- told a total with no anticipo, and had to ask how much to pay to
-- hold the reservation. Villa San Ricardo's deposit is 50%, but other
-- hotel-vertical accounts may set a different figure, so this is a
-- per-account column (same pattern as `default_currency`, migration
-- 021) rather than a hardcoded constant.
--
-- RLS: no change needed. The existing `accounts_update` policy (017)
-- already restricts writes to admins+, which is exactly who should
-- change an account-wide setting.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS deposit_percent SMALLINT NOT NULL DEFAULT 50;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_deposit_percent_range;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_deposit_percent_range
  CHECK (deposit_percent > 0 AND deposit_percent <= 100);
