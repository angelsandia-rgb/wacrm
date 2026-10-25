-- ============================================================
-- 168: explicit Data API grants on every public table.
--
-- From 2026-10-30 Supabase stops auto-granting anon/authenticated/
-- service_role on NEW tables in `public` (existing projects keep the
-- grants they already have). Our migrations never granted explicitly —
-- they relied on that default — so a project rebuilt from this folder
-- (disaster recovery, RUNBOOK §9; a preview branch; `supabase db reset`)
-- would end up with tables the app cannot reach ("permission denied").
--
-- This pins the grants production has today (snapshot 2026-10-24), so
-- the migration chain reproduces them on any project. On production it
-- is a no-op. Exceptions mirror earlier deliberate REVOKEs; column-level
-- grants (e.g. notifications) still come from their own migrations.
--
-- From here on, every migration that creates a public table must GRANT
-- in the same file (enforced by src/lib/supabase/migration-grants.test.ts).
-- ============================================================

DO $$
DECLARE
  t text;
  full_all text[] := ARRAY[
    'account_invitations','accounts','ai_configs','ai_followup_log',
    'ai_knowledge_chunks','ai_knowledge_documents','ai_usage_log','api_keys',
    'appointment_history','appointments','automation_logs',
    'automation_pending_executions','automation_steps','automations',
    'broadcast_recipients','broadcasts','clinic_files','contact_custom_values',
    'contact_notes','contact_tags','contacts','conversations','csat_config',
    'csat_surveys','custom_fields','deals','doctor_availability',
    'doctor_profiles','doctor_time_off','facebook_config','flow_nodes',
    'flow_run_events','flow_runs','flows','google_calendar_config',
    'google_sheets_config','instagram_config','kpi_period_spend',
    'member_presence','message_reactions','message_templates','messages',
    'note_templates','onboarding_forms','onboarding_intakes',
    'patient_profiles','pipeline_stages','pipelines',
    'platform_company_invitations','platform_settings','product_categories',
    'product_price_options','product_rates','products','profiles',
    'push_subscriptions','quick_replies','quote_items','quotes',
    'reservation_requests','saved_views','support_tickets','tags','tasks',
    'visit_note_revisions','visits','webhook_endpoints','whatsapp_config'];
  -- No anon access.
  no_anon text[] := ARRAY['ai_action_log','system_alert_watcher_runs','system_alerts'];
  -- Service role only.
  service_only text[] := ARRAY['data_retention_runs','rate_limit_buckets','system_heartbeats'];
  -- Read-only for anon/authenticated; writes go through SECURITY DEFINER RPCs.
  read_only text[] := ARRAY['ai_usage_monthly','webhook_deliveries'];
BEGIN
  FOREACH t IN ARRAY full_all || no_anon || service_only || read_only || ARRAY['notifications'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '168: table public.% not found, skipped', t;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    IF t = ANY (full_all) THEN
      EXECUTE format('GRANT ALL ON TABLE public.%I TO anon, authenticated', t);
    ELSIF t = ANY (no_anon) THEN
      EXECUTE format('GRANT ALL ON TABLE public.%I TO authenticated', t);
    ELSIF t = ANY (read_only) THEN
      EXECUTE format('GRANT SELECT, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.%I TO anon, authenticated', t);
    ELSIF t = 'notifications' THEN
      EXECUTE 'GRANT ALL ON TABLE public.notifications TO anon';
      EXECUTE 'GRANT SELECT, INSERT, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.notifications TO authenticated';
    END IF;
  END LOOP;

  IF to_regclass('public.support_tickets_ticket_number_seq') IS NOT NULL THEN
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.support_tickets_ticket_number_seq
      TO anon, authenticated, service_role;
  END IF;
END $$;
