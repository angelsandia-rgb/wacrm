-- ============================================================
-- 175: merge_contacts(keep, duplicate) — fold a duplicate contact
-- (e.g. the same person on WhatsApp and Instagram) into another
-- (respond.io parity).
--   * Admin+ of the contacts' account only; both must be in it.
--   * Every row pointing at the duplicate moves to the kept contact.
--     Tags / custom values the kept contact already has win.
--   * Refuses (no data lost) when both have a conversation on the same
--     WhatsApp number or both have a patient profile.
--   * Blank fields on the kept contact are filled from the duplicate,
--     then the duplicate is deleted.
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_contacts(p_keep uuid, p_duplicate uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k public.contacts;
  d public.contacts;
BEGIN
  IF p_keep = p_duplicate THEN
    RAISE EXCEPTION 'cannot merge a contact into itself' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO k FROM public.contacts WHERE id = p_keep FOR UPDATE;
  SELECT * INTO d FROM public.contacts WHERE id = p_duplicate FOR UPDATE;
  IF k.id IS NULL OR d.id IS NULL OR k.account_id <> d.account_id
     OR NOT is_account_member(k.account_id, 'admin') THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.conversations a JOIN public.conversations b
      ON b.whatsapp_config_id = a.whatsapp_config_id AND b.channel = a.channel
    WHERE a.contact_id = p_keep AND b.contact_id = p_duplicate
  ) THEN
    RAISE EXCEPTION 'both contacts have a conversation on the same channel' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.patient_profiles WHERE contact_id = p_keep)
     AND EXISTS (SELECT 1 FROM public.patient_profiles WHERE contact_id = p_duplicate) THEN
    RAISE EXCEPTION 'both contacts have a patient profile' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.contact_tags (contact_id, tag_id)
    SELECT p_keep, tag_id FROM public.contact_tags WHERE contact_id = p_duplicate
    ON CONFLICT DO NOTHING;
  UPDATE public.contact_custom_values v SET contact_id = p_keep
    WHERE v.contact_id = p_duplicate
      AND NOT EXISTS (SELECT 1 FROM public.contact_custom_values x
                      WHERE x.contact_id = p_keep AND x.custom_field_id = v.custom_field_id);
  -- At most one active flow run per contact; the duplicate's extra one ends.
  UPDATE public.flow_runs SET status = 'paused_by_agent'
    WHERE contact_id = p_duplicate AND status = 'active'
      AND EXISTS (SELECT 1 FROM public.flow_runs WHERE contact_id = p_keep AND status = 'active');

  UPDATE public.conversations SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.contact_notes SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.deals SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.broadcast_recipients SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.automation_logs SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.automation_pending_executions SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.flow_runs SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.notifications SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.quotes SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.tasks SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.ai_followup_log SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.reservation_requests SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.patient_profiles SET contact_id = p_keep WHERE contact_id = p_duplicate;
  UPDATE public.csat_surveys SET contact_id = p_keep WHERE contact_id = p_duplicate;

  -- Delete first: the duplicate's phone / Instagram / Facebook ids are
  -- unique per account and move to the kept contact below.
  DELETE FROM public.contacts WHERE id = p_duplicate;

  UPDATE public.contacts SET
    name = COALESCE(NULLIF(k.name, ''), d.name),
    phone = CASE WHEN COALESCE(k.phone_normalized, '') = '' THEN d.phone ELSE k.phone END,
    phone_normalized = CASE WHEN COALESCE(k.phone_normalized, '') = '' THEN d.phone_normalized ELSE k.phone_normalized END,
    email = COALESCE(NULLIF(k.email, ''), d.email),
    company = COALESCE(NULLIF(k.company, ''), d.company),
    avatar_url = COALESCE(k.avatar_url, d.avatar_url),
    instagram_id = COALESCE(k.instagram_id, d.instagram_id),
    instagram_username = COALESCE(k.instagram_username, d.instagram_username),
    facebook_id = COALESCE(k.facebook_id, d.facebook_id),
    facebook_username = COALESCE(k.facebook_username, d.facebook_username),
    lead_temperature = COALESCE(k.lead_temperature, d.lead_temperature),
    referral = COALESCE(k.referral, d.referral),
    created_at = LEAST(k.created_at, d.created_at)
  WHERE id = p_keep;
END $$;

REVOKE EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid) TO authenticated;
