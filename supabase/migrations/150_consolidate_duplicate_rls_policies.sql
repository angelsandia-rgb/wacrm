-- Consolidate duplicate permissive RLS policies (Supabase performance
-- advisor `multiple_permissive_policies`, deferred by migration 102).
--
-- 13 tables had a `*_select` policy plus a `FOR ALL` write policy, so
-- Postgres evaluated BOTH on every SELECT. The write policy's condition
-- is always at least as strict as the select one — it requires role
-- agent/admin via is_account_member(x, role), and is_account_member's
-- role ladder is monotonic (owner > admin > agent > viewer, default
-- viewer), so an agent/admin always satisfies the plain membership check.
-- Splitting each FOR ALL policy into INSERT / UPDATE / DELETE with the
-- exact same expressions therefore leaves every read and write decision
-- unchanged; SELECT is now decided by the select policy alone.
--
-- accounts / profiles had a member select policy plus a platform-admin
-- select policy; they're merged into one `A OR B` (logically identical).
--
-- Expressions copied from pg_policies in production, 2026-09-23.

-- account_invitations
drop policy if exists account_invitations_modify on public.account_invitations;
create policy account_invitations_insert on public.account_invitations for insert with check (public.is_account_member(account_id, 'admin'::public.account_role_enum));
create policy account_invitations_update on public.account_invitations for update using (public.is_account_member(account_id, 'admin'::public.account_role_enum)) with check (public.is_account_member(account_id, 'admin'::public.account_role_enum));
create policy account_invitations_delete on public.account_invitations for delete using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

-- doctor_availability
drop policy if exists doctor_availability_write on public.doctor_availability;
create policy doctor_availability_insert on public.doctor_availability for insert with check (public.is_account_member(account_id, 'admin'::public.account_role_enum));
create policy doctor_availability_update on public.doctor_availability for update using (public.is_account_member(account_id, 'admin'::public.account_role_enum)) with check (public.is_account_member(account_id, 'admin'::public.account_role_enum));
create policy doctor_availability_delete on public.doctor_availability for delete using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

-- doctor_profiles
drop policy if exists doctor_profiles_write on public.doctor_profiles;
create policy doctor_profiles_insert on public.doctor_profiles for insert with check (public.is_account_member(account_id, 'admin'::public.account_role_enum));
create policy doctor_profiles_update on public.doctor_profiles for update using (public.is_account_member(account_id, 'admin'::public.account_role_enum)) with check (public.is_account_member(account_id, 'admin'::public.account_role_enum));
create policy doctor_profiles_delete on public.doctor_profiles for delete using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

-- doctor_time_off
drop policy if exists doctor_time_off_write on public.doctor_time_off;
create policy doctor_time_off_insert on public.doctor_time_off for insert with check (public.is_account_member(account_id, 'admin'::public.account_role_enum));
create policy doctor_time_off_update on public.doctor_time_off for update using (public.is_account_member(account_id, 'admin'::public.account_role_enum)) with check (public.is_account_member(account_id, 'admin'::public.account_role_enum));
create policy doctor_time_off_delete on public.doctor_time_off for delete using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

-- note_templates
drop policy if exists note_templates_write on public.note_templates;
create policy note_templates_insert on public.note_templates for insert with check (public.is_account_member(account_id, 'agent'::public.account_role_enum));
create policy note_templates_update on public.note_templates for update using (public.is_account_member(account_id, 'agent'::public.account_role_enum)) with check (public.is_account_member(account_id, 'agent'::public.account_role_enum));
create policy note_templates_delete on public.note_templates for delete using (public.is_account_member(account_id, 'agent'::public.account_role_enum));

-- automation_steps
drop policy if exists automation_steps_modify on public.automation_steps;
create policy automation_steps_insert on public.automation_steps for insert with check (exists (select 1 from public.automations a where a.id = automation_steps.automation_id and public.is_account_member(a.account_id, 'agent'::public.account_role_enum)));
create policy automation_steps_update on public.automation_steps for update using (exists (select 1 from public.automations a where a.id = automation_steps.automation_id and public.is_account_member(a.account_id, 'agent'::public.account_role_enum))) with check (exists (select 1 from public.automations a where a.id = automation_steps.automation_id and public.is_account_member(a.account_id, 'agent'::public.account_role_enum)));
create policy automation_steps_delete on public.automation_steps for delete using (exists (select 1 from public.automations a where a.id = automation_steps.automation_id and public.is_account_member(a.account_id, 'agent'::public.account_role_enum)));

-- broadcast_recipients
drop policy if exists broadcast_recipients_modify on public.broadcast_recipients;
create policy broadcast_recipients_insert on public.broadcast_recipients for insert with check (exists (select 1 from public.broadcasts b where b.id = broadcast_recipients.broadcast_id and public.is_account_member(b.account_id, 'agent'::public.account_role_enum)));
create policy broadcast_recipients_update on public.broadcast_recipients for update using (exists (select 1 from public.broadcasts b where b.id = broadcast_recipients.broadcast_id and public.is_account_member(b.account_id, 'agent'::public.account_role_enum))) with check (exists (select 1 from public.broadcasts b where b.id = broadcast_recipients.broadcast_id and public.is_account_member(b.account_id, 'agent'::public.account_role_enum)));
create policy broadcast_recipients_delete on public.broadcast_recipients for delete using (exists (select 1 from public.broadcasts b where b.id = broadcast_recipients.broadcast_id and public.is_account_member(b.account_id, 'agent'::public.account_role_enum)));

-- contact_custom_values
drop policy if exists contact_custom_values_modify on public.contact_custom_values;
create policy contact_custom_values_insert on public.contact_custom_values for insert with check (exists (select 1 from public.contacts c where c.id = contact_custom_values.contact_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));
create policy contact_custom_values_update on public.contact_custom_values for update using (exists (select 1 from public.contacts c where c.id = contact_custom_values.contact_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum))) with check (exists (select 1 from public.contacts c where c.id = contact_custom_values.contact_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));
create policy contact_custom_values_delete on public.contact_custom_values for delete using (exists (select 1 from public.contacts c where c.id = contact_custom_values.contact_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));

-- contact_tags
drop policy if exists contact_tags_modify on public.contact_tags;
create policy contact_tags_insert on public.contact_tags for insert with check (exists (select 1 from public.contacts c where c.id = contact_tags.contact_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));
create policy contact_tags_update on public.contact_tags for update using (exists (select 1 from public.contacts c where c.id = contact_tags.contact_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum))) with check (exists (select 1 from public.contacts c where c.id = contact_tags.contact_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));
create policy contact_tags_delete on public.contact_tags for delete using (exists (select 1 from public.contacts c where c.id = contact_tags.contact_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));

-- flow_nodes
drop policy if exists flow_nodes_modify on public.flow_nodes;
create policy flow_nodes_insert on public.flow_nodes for insert with check (exists (select 1 from public.flows f where f.id = flow_nodes.flow_id and public.is_account_member(f.account_id, 'agent'::public.account_role_enum)));
create policy flow_nodes_update on public.flow_nodes for update using (exists (select 1 from public.flows f where f.id = flow_nodes.flow_id and public.is_account_member(f.account_id, 'agent'::public.account_role_enum))) with check (exists (select 1 from public.flows f where f.id = flow_nodes.flow_id and public.is_account_member(f.account_id, 'agent'::public.account_role_enum)));
create policy flow_nodes_delete on public.flow_nodes for delete using (exists (select 1 from public.flows f where f.id = flow_nodes.flow_id and public.is_account_member(f.account_id, 'agent'::public.account_role_enum)));

-- message_reactions
drop policy if exists message_reactions_modify on public.message_reactions;
create policy message_reactions_insert on public.message_reactions for insert with check (exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id where m.id = message_reactions.message_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));
create policy message_reactions_update on public.message_reactions for update using (exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id where m.id = message_reactions.message_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum))) with check (exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id where m.id = message_reactions.message_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));
create policy message_reactions_delete on public.message_reactions for delete using (exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id where m.id = message_reactions.message_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));

-- messages
drop policy if exists messages_modify on public.messages;
create policy messages_insert on public.messages for insert with check (exists (select 1 from public.conversations c where c.id = messages.conversation_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));
create policy messages_update on public.messages for update using (exists (select 1 from public.conversations c where c.id = messages.conversation_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum))) with check (exists (select 1 from public.conversations c where c.id = messages.conversation_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));
create policy messages_delete on public.messages for delete using (exists (select 1 from public.conversations c where c.id = messages.conversation_id and public.is_account_member(c.account_id, 'agent'::public.account_role_enum)));

-- pipeline_stages
drop policy if exists pipeline_stages_modify on public.pipeline_stages;
create policy pipeline_stages_insert on public.pipeline_stages for insert with check (exists (select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id and public.is_account_member(p.account_id, 'admin'::public.account_role_enum)));
create policy pipeline_stages_update on public.pipeline_stages for update using (exists (select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id and public.is_account_member(p.account_id, 'admin'::public.account_role_enum))) with check (exists (select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id and public.is_account_member(p.account_id, 'admin'::public.account_role_enum)));
create policy pipeline_stages_delete on public.pipeline_stages for delete using (exists (select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id and public.is_account_member(p.account_id, 'admin'::public.account_role_enum)));

-- accounts: member OR platform admin, one policy
drop policy if exists platform_admin_accounts_select on public.accounts;
drop policy if exists accounts_select on public.accounts;
create policy accounts_select on public.accounts for select
  using (public.is_account_identity_member(id) or (select public.is_platform_admin()));

-- profiles: self OR same-account member OR platform admin, one policy
drop policy if exists platform_admin_profiles_select on public.profiles;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (((select auth.uid()) = user_id) or public.is_account_member(account_id) or (select public.is_platform_admin()));
