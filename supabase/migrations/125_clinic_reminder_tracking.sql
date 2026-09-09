-- ============================================================
-- 125_clinic_reminder_tracking.sql — Sandía Clínica, Fase 10: two
-- "already handled" stamps for the reminder sweep
-- (/api/clinic/reminders/cron).
--
--   - appointments.confirmation_reminder_sent_at — set when the 24h
--     "¿confirmas tu asistencia?" message went out, so it's sent once.
--   - visits.follow_up_nudged_at — set when the "recomendó seguimiento"
--     message went out (or the patient turned out to already be
--     booked), so a follow-up is nudged once.
--
-- Depends on 123. Idempotent.
-- ============================================================

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS confirmation_reminder_sent_at TIMESTAMPTZ;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS follow_up_nudged_at TIMESTAMPTZ;

-- the sweep's working sets
CREATE INDEX IF NOT EXISTS idx_appointments_confirm_sweep
  ON public.appointments(account_id, scheduled_at)
  WHERE confirmation_status = 'pending'
    AND status IN ('SCHEDULED', 'RESCHEDULED');

CREATE INDEX IF NOT EXISTS idx_visits_followup_sweep
  ON public.visits(account_id, follow_up_date)
  WHERE follow_up_date IS NOT NULL AND follow_up_nudged_at IS NULL;
