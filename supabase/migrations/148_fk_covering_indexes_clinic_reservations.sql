-- Covering indexes for the foreign keys the Supabase performance advisor
-- still flags (`unindexed_foreign_keys`, 2026-09-23) — all added after
-- migration 102's pass, by the clinic vertical (122-129) and reservations
-- (112, 120).
--
-- Without one, every DELETE/UPDATE of the referenced row (a user, a
-- product, a doctor, a whole account on company delete) sequentially
-- scans the referencing table for the FK check, and joins through the
-- key can't use an index. Purely additive; idempotent.

create index if not exists idx_appointment_history_account_id on public.appointment_history(account_id);
create index if not exists idx_appointment_history_changed_by on public.appointment_history(changed_by);

create index if not exists idx_appointments_created_by on public.appointments(created_by);
create index if not exists idx_appointments_service_id on public.appointments(service_id);
create index if not exists idx_appointments_updated_by on public.appointments(updated_by);

create index if not exists idx_clinic_files_uploaded_by on public.clinic_files(uploaded_by);

create index if not exists idx_doctor_availability_doctor_id on public.doctor_availability(doctor_id);
create index if not exists idx_doctor_profiles_user_id on public.doctor_profiles(user_id);
create index if not exists idx_doctor_time_off_doctor_id on public.doctor_time_off(doctor_id);

create index if not exists idx_note_templates_created_by on public.note_templates(created_by);

create index if not exists idx_reservation_requests_product_id on public.reservation_requests(product_id);
create index if not exists idx_reservation_requests_quote_id on public.reservation_requests(quote_id);

create index if not exists idx_visit_note_revisions_account_id on public.visit_note_revisions(account_id);
create index if not exists idx_visit_note_revisions_edited_by on public.visit_note_revisions(edited_by);

create index if not exists idx_visits_created_by on public.visits(created_by);
create index if not exists idx_visits_doctor_id on public.visits(doctor_id);
create index if not exists idx_visits_service_id on public.visits(service_id);
create index if not exists idx_visits_updated_by on public.visits(updated_by);
