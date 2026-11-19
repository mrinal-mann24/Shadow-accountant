-- Shadow Teams 1:1 chat memory and pending "save to client" requests.
-- Approved in chat on 19 Nov 2026 ("Approve all"). Service role only (RLS on, no policies).
--
-- kind 'user' / 'assistant': the last turns of a person's 1:1 chat with Shadow (memory, last 2 hours, 10 turns).
-- kind 'pending_save': a transcript or meeting notes waiting for the Save button. meta holds
--   { clientId, clientName, title, meetingDate }. The row is deleted when Save or Cancel is clicked.
-- Rows older than 7 days are deleted by the teams-notify job.
--
-- Rollback: drop table if exists public.teams_chat;

create table if not exists public.teams_chat (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  kind text not null check (kind in ('user', 'assistant', 'pending_save')),
  content text not null check (char_length(content) <= 40000),
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists teams_chat_user_idx on public.teams_chat (user_email, created_at desc);
create index if not exists teams_chat_created_idx on public.teams_chat (created_at);

alter table public.teams_chat enable row level security;
-- No policies: only the service role (server code) reads or writes this table.
