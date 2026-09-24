-- Drop the legacy free-form `profiles.role` column (migration 001).
--
-- Superseded by the typed `account_role` enum in 017_account_sharing.sql
-- and never read since: no app code, RPC, trigger, policy, view or index
-- references it (checked against production 2026-09-23 — pg_depend has
-- no dependents, and no function body mentions NEW.role / OLD.role or
-- selects it). Keeping it only invited confusion with `account_role`
-- (SANDIA diagnosis, section M).

alter table public.profiles drop column if exists role;
