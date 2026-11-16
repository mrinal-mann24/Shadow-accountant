-- PROPOSAL ONLY. NOT APPLIED. Do not run without explicit approval in chat (CLAUDE.md hard rules).
-- Owner: auth agent. Stage 2 (Auth and roles) in docs/ROADMAP.md.
--
-- Goal: let the logged-in user's own Supabase session (role `authenticated`) read exactly its data,
-- so the browser and the context agent can later drop the service-role reads in lib/data/*.
--   senior_accountant (or no role, matched by email): only clients where clients.va_id is their vas row
--   admin, engineer: everything
-- Role comes from the JWT claim app_metadata.role (set only by the service role, users cannot edit it).
-- Accountant mapping: lower(vas.email) = lower(jwt email), same rule as lib/auth/roles.ts, and only for a
-- Microsoft (azure) sign in (app_metadata.provider = 'azure'), so an email / password or magic link session
-- for an accountant's email never inherits their clients. The app also requires email_confirmed_at.
-- The mapping trusts vas.email: Stage 1 must remove anon write access on vas before this is applied.
--
-- Notes
-- * Additive only: new policies for `authenticated`. Removing the anon policies, enabling RLS on
--   client_contacts / addition_charges and revoking anon grants is Stage 1 and is NOT in this file.
--   These policies only take effect on tables where RLS is enabled.
-- * No new functions: the checks are inline. `(select auth.jwt())` is wrapped so Postgres evaluates it
--   once per statement, not per row.
-- * The vas policy has no subquery, so the clients -> vas subqueries cannot recurse.
-- * Engineer "view as" is an app-level feature (cookie). RLS still sees the engineer's own JWT (all rows),
--   so view-as scoping stays in lib/data/* via AppUser.
-- * JWT claims refresh on token refresh (about 1 hour). A role change made by an Admin reaches RLS then;
--   the app itself reads the role fresh on each request (auth.getUser()).
-- * Writes: only the few the app needs (ticket updates by the owner, client assignment by admin).
--   Everything else stays service-role only (jobs, sync).

begin;

-- vas: accountants read their own row; admin / engineer read all.
create policy auth_vas_select on public.vas
  for select to authenticated
  using (
    ((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'engineer')
    or (
      ((select auth.jwt()) -> 'app_metadata' ->> 'provider') = 'azure'
      and lower(email) = lower((select auth.jwt()) ->> 'email')
    )
  );

-- clients: own clients via va_id; admin / engineer all.
create policy auth_clients_select on public.clients
  for select to authenticated
  using (
    ((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'engineer')
    or (
      ((select auth.jwt()) -> 'app_metadata' ->> 'provider') = 'azure'
      and va_id in (select v.va_id from public.vas v where lower(v.email) = lower((select auth.jwt()) ->> 'email'))
    )
  );

-- clients: admin can update (assignment). Column limits are enforced by the app (lib/data assignClient).
create policy auth_clients_update_admin on public.clients
  for update to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin')
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

-- Child tables keyed by client_id: visible when the parent client is visible (clients policy applies inside).
create policy auth_client_messages_select on public.client_messages
  for select to authenticated
  using (client_id in (select c.client_id from public.clients c));

create policy auth_conversations_select on public.conversations
  for select to authenticated
  using (client_id in (select c.client_id from public.clients c));

-- Tickets: the owning accountant (or admin / engineer) can update status, tag, summary, title.
create policy auth_conversations_update on public.conversations
  for update to authenticated
  using (client_id in (select c.client_id from public.clients c))
  with check (client_id in (select c.client_id from public.clients c));

create policy auth_client_scores_select on public.client_scores
  for select to authenticated
  using (client_id in (select c.client_id from public.clients c));

create policy auth_client_score_history_select on public.client_score_history
  for select to authenticated
  using (client_id in (select c.client_id from public.clients c));

create policy auth_document_uploads_select on public.document_uploads
  for select to authenticated
  using (client_id in (select c.client_id from public.clients c));

create policy auth_va_meeting_transcripts_select on public.va_meeting_transcripts
  for select to authenticated
  using (client_id in (select c.client_id from public.clients c));

create policy auth_client_contacts_select on public.client_contacts
  for select to authenticated
  using (client_id in (select c.client_id from public.clients c));

create policy auth_flagged_messages_select on public.flagged_messages
  for select to authenticated
  using (client_id in (select c.client_id from public.clients c));

-- council_verdicts: via the message's client.
create policy auth_council_verdicts_select on public.council_verdicts
  for select to authenticated
  using (message_id in (select m.message_id from public.client_messages m));

-- Config and system tables: admin / engineer read only. Writes stay service role.
create policy auth_score_weights_select on public.score_weights
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'engineer'));

create policy auth_settings_select on public.settings
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'engineer'));

create policy auth_message_processing_log_select on public.message_processing_log
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'engineer');

-- Not covered on purpose (service role only for now): invoices (no client_id), renewal_jobs, client_pricing,
-- addition_charges, release_note_sends. Billing data needs its own decision.

commit;

-- Proof to run on a branch before approval (one per role), e.g.:
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"<accountant email>","app_metadata":{"provider":"azure"}}';
--   select count(*) from clients;            -- expect only that accountant's clients
--   set local request.jwt.claims = '{"email":"x@y","app_metadata":{"role":"admin"}}';
--   select count(*) from clients;            -- expect all

-- Rollback
-- begin;
-- drop policy if exists auth_vas_select on public.vas;
-- drop policy if exists auth_clients_select on public.clients;
-- drop policy if exists auth_clients_update_admin on public.clients;
-- drop policy if exists auth_client_messages_select on public.client_messages;
-- drop policy if exists auth_conversations_select on public.conversations;
-- drop policy if exists auth_conversations_update on public.conversations;
-- drop policy if exists auth_client_scores_select on public.client_scores;
-- drop policy if exists auth_client_score_history_select on public.client_score_history;
-- drop policy if exists auth_document_uploads_select on public.document_uploads;
-- drop policy if exists auth_va_meeting_transcripts_select on public.va_meeting_transcripts;
-- drop policy if exists auth_client_contacts_select on public.client_contacts;
-- drop policy if exists auth_flagged_messages_select on public.flagged_messages;
-- drop policy if exists auth_council_verdicts_select on public.council_verdicts;
-- drop policy if exists auth_score_weights_select on public.score_weights;
-- drop policy if exists auth_settings_select on public.settings;
-- drop policy if exists auth_message_processing_log_select on public.message_processing_log;
-- commit;
