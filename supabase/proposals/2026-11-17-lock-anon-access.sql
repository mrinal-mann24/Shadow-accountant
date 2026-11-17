-- APPLIED on 17 Nov 2026 (user approved in chat: "APlly the Critial 1"). Critical 1 from the pre-pilot review.
-- Verified after applying: 0 anon policies left, RLS on for client_contacts and addition_charges; as the anon role the
-- meeting picker returns 30 rows and clients, vas, client_messages, client_contacts and conversations return 0 rows.
-- Do not run the block below again (it is safe to re-run, but there is nothing left to change). Rollback at the end.
--
-- Problem (checked live, read-only):
--   * The public "anon" key has full table grants (select, insert, update, delete, truncate) on every table below.
--   * RLS is OFF on client_contacts and addition_charges, so anyone with the anon key can read, change or delete
--     client phone numbers and pricing.
--   * RLS is on elsewhere, but these policies let anon in: "anon full access to vas" (read AND write: someone could
--     change an accountant's email and widen what they see in Shadow) and "anon read ..." on clients,
--     client_messages, conversations, client_scores, client_score_history, council_verdicts (all client chats).
--
-- Who uses the anon key today (Supabase API logs, last 24 hours):
--   * Only 1 request: GET clients_meeting_picker (a browser tool that lists active clients' name and email).
--   * Shadow uses anon only for sign-in (auth), never for tables. va-bot, n8n and the billing service use the
--     service role key, which bypasses RLS and is not affected.
--
-- After this change: anon can only read clients_meeting_picker (client_id, client_name, email of active clients),
-- exactly what that tool reads today. Everything else is closed to anon.

begin;

-- 1. Turn on RLS for the two open tables. No policies = anon and logged-in users get nothing; service role still works.
alter table public.client_contacts enable row level security;
alter table public.addition_charges enable row level security;

-- 2. Remove the anon policies.
drop policy if exists "anon full access to vas" on public.vas;
drop policy if exists "anon read clients" on public.clients;
drop policy if exists "anon read client_messages" on public.client_messages;
drop policy if exists "anon read conversations" on public.conversations;
drop policy if exists "anon read client_scores" on public.client_scores;
drop policy if exists "anon read client_score_history" on public.client_score_history;
drop policy if exists "anon read council_verdicts" on public.council_verdicts;

-- 3. Keep the meeting picker working without opening clients: the view runs as its owner and anon may only read it.
alter view public.clients_meeting_picker set (security_invoker = off);
-- The view now runs as its owner (postgres, bypasses RLS), so take it away from signed-in users and PUBLIC too:
-- only the anon meeting picker may read it. Supabase's security advisor will list it as a security-definer view;
-- that is deliberate (it exposes only client_id, client_name and email of active clients). Better later: serve the
-- picker from a server route and drop anon access completely.
revoke all on public.clients_meeting_picker from anon, authenticated, public;
grant select on public.clients_meeting_picker to anon;

commit;

-- Check after applying (expect: no anon policies left; RLS on for both tables; picker still returns rows as anon):
--   select tablename, policyname from pg_policies where schemaname = 'public' and roles::text like '%anon%';
--   select relname, relrowsecurity from pg_class where relname in ('client_contacts', 'addition_charges');

-- Rollback (puts everything back exactly as it was on 17 Nov 2026):
-- begin;
-- alter table public.client_contacts disable row level security;
-- alter table public.addition_charges disable row level security;
-- create policy "anon full access to vas" on public.vas for all to anon using (true) with check (true);
-- create policy "anon read clients" on public.clients for select to anon using (true);
-- create policy "anon read client_messages" on public.client_messages for select to anon using (true);
-- create policy "anon read conversations" on public.conversations for select to anon using (true);
-- create policy "anon read client_scores" on public.client_scores for select to anon using (true);
-- create policy "anon read client_score_history" on public.client_score_history for select to anon using (true);
-- create policy "anon read council_verdicts" on public.council_verdicts for select to anon using (true);
-- alter view public.clients_meeting_picker set (security_invoker = on);
-- grant all on public.clients_meeting_picker to anon, authenticated;
-- commit;
