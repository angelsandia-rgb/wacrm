-- HOTFIX (applied to production 2026-09-24 ~01:05 UTC, before this file
-- was committed): migration 149 dropped profiles.role, but the client
-- auth hook (src/hooks/use-auth.tsx) still named it in its profiles
-- select — a string column list TypeScript can't check — so the profile
-- load would fail for every user. Production logs show no user loaded the
-- app during the ~20 minutes the column was gone.
--
-- 149's "no reader anywhere" check missed it because the grep for the
-- column name filtered out lines that also mention `account_role`.
-- src/lib/auth/profile-columns.test.ts now fails CI on any profiles
-- select that names `role`. The column is dropped again by 155 once the
-- fixed client is deployed.

alter table public.profiles add column if not exists role text default 'user';
