-- AI reply drafts (Suggested reply in the Tickets panel). Approved in chat on 27 Nov 2026.
-- Run once in the Supabase SQL editor (project "Supabase VA"). Nothing in the app writes until this exists.
--
-- 1. reply_suggestions: every suggested reply Shadow showed, and what the accountant did with it (copied as is,
--    edited then copied, or discarded). Edited replies are what the AI learns from: they go into the next drafts
--    straight away and into the daily style guide refresh (/api/jobs/style-guides).
--    Text is masked before it is stored (no OTPs, passwords, phone or account numbers).
-- 2. settings 'reply_pilot_clients': the clients that get suggested replies (the 4 pilot clients).
--    Their style guides are stored by the job under settings 'reply_style_guide:<client_id>'.

begin;

create table if not exists public.reply_suggestions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  client_id uuid not null references public.clients(client_id) on delete cascade,
  user_email text not null,
  model text not null,
  guide_version integer,
  prompt_version text not null,
  draft text not null,
  final_text text,
  action text check (action in ('copied', 'edited', 'discarded')),
  created_at timestamptz not null default now(),
  acted_at timestamptz
);

create index if not exists reply_suggestions_client_created_idx on public.reply_suggestions (client_id, created_at desc);

-- Server only (service role), like every other table until RLS for logged-in users is approved.
alter table public.reply_suggestions enable row level security;

insert into public.settings (key, value, note)
values (
  'reply_pilot_clients',
  '["e3cfbd31-4cbe-4372-8d66-61ad4ed75338","289a9698-1f0c-4be2-bb3c-7c4521d450e2","41bcfadb-5cd3-4ed2-b7ec-5bc6d80075b8","67857159-834e-4412-8404-11325fdfa0c7"]',
  'Suggested reply pilot: KRRD, Nirved Medicals, Forelife, AJ Metalware (JSON list of client ids)'
)
on conflict (key) do nothing;

commit;

-- Rollback (removes the feature's data; the app then hides the Suggested reply box again):
-- begin;
-- drop table if exists public.reply_suggestions;
-- delete from public.settings where key = 'reply_pilot_clients' or key like 'reply_style_guide:%';
-- commit;
