-- ============================================================
-- 156 — per-account feature flags + voice-note transcripts.
--
-- accounts.feature_flags: keys of features switched on for this account
-- only (registry: src/lib/features/flags.ts). The platform admin toggles
-- them from /admin, so a new or risky feature can run on one account
-- (DEMO) before everyone gets it. Unknown keys are ignored by the app.
--
-- messages.transcript: text of an inbound voice note, filled the first
-- time the AI needs it (src/lib/ai/voice-notes.ts), so each note is
-- transcribed — and paid for — once. Also shown under the audio player
-- in the inbox.
--
-- Additive and idempotent. Apply BEFORE deploying code that selects
-- messages.transcript (see the 2026-09-06 media_type outage).
-- ============================================================

alter table public.accounts
  add column if not exists feature_flags text[] not null default '{}';

alter table public.messages
  add column if not exists transcript text;
