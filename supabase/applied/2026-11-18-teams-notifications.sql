-- APPLIED 18 Nov 2026 to Supabase VA (run by the user after approval in chat, "OK both"); table present with RLS on.
-- one table for the Shadow Teams bot.
-- Run once in the Supabase SQL editor (Supabase VA). Rollback at the bottom.
--
-- What it stores: every card the bot posted (new ticket, SLA reminder, escalation, new files), so a card is
-- never sent twice, and what the person did with it in Teams (Start, Close, Not a ticket, Reassign, Ping).
-- "Not a ticket" clicks double as the council accuracy signal for the pilot.
--
-- Who uses it: only Shadow's server code with the service role key (lib/teams). RLS is on with no policies,
-- like every other table here, so the anon key and logged-in browsers cannot read or write it.
-- Nothing else (va-bot, n8n, dashboards) reads or writes it.

create table if not exists public.teams_notifications (
  id          uuid primary key default gen_random_uuid(),
  -- ticket: new ticket card. reminder / escalation: one per waiting period. files: one row per upload.
  kind        text not null check (kind in ('ticket', 'reminder', 'escalation', 'files')),
  -- ticket: conversations.id. reminder / escalation: '<conversations.id>@<last_message_at ISO>'.
  -- files: document_uploads.upload_id.
  ref_id      text not null,
  client_id   uuid,
  channel_id  text not null,                 -- Teams conversation id the card went to
  activity_id text,                          -- Teams message id, used to update the card after a click
  sent_at     timestamptz not null default now(),
  action      text check (action in ('started', 'closed', 'not_ticket', 'reassigned', 'pinged')),
  action_by   text,                          -- email of the person who clicked
  action_at   timestamptz,
  constraint teams_notifications_kind_ref_key unique (kind, ref_id)
);

create index if not exists teams_notifications_client_idx on public.teams_notifications (client_id, sent_at desc);

alter table public.teams_notifications enable row level security;
revoke all on public.teams_notifications from anon, authenticated;

-- Check after running:
--   select count(*) from public.teams_notifications;   -- 0
--   select relrowsecurity from pg_class where relname = 'teams_notifications';   -- true

-- ROLLBACK (drops the table and everything the bot recorded):
--   drop table if exists public.teams_notifications;
