-- Drop the legacy profiles.role column for good (see 149 and the 154
-- hotfix). Apply only AFTER the build that removed it from
-- src/hooks/use-auth.tsx and src/components/settings/profile-form.tsx is
-- live; src/lib/auth/profile-columns.test.ts keeps it from coming back.

alter table public.profiles drop column if exists role;
