-- APPLIED 18 Nov 2026 to Supabase VA after approval in chat ("Approve table"). Verified: RLS on, no policies,
-- no anon/authenticated grants, 0 rows.
-- one table for promise tracking, the document chase list and
-- the repeat-ask alarm. Run once in the Supabase SQL editor (Supabase VA). Rollback at the bottom.
--
-- What it stores: things the team or the client said that must be followed up.
--   promise     a team member promised something with a time ("will share the MIS by tomorrow")
--   document    a team member asked the client for a document ("please share the CC statement")
--   repeat_ask  a client asked again for something still not answered ("when will this happen?")
-- Rows are created by the follow-ups job (lib/followups, service role) and closed by the job (delivery or
-- reply detected), by a button in Teams, or on the client page.
--
-- Who uses it: only Shadow's server code with the service role key. RLS on, no policies, like every other table,
-- so the anon key and browsers cannot read or write it. va-bot, n8n and dashboards do not touch it.

create table if not exists public.follow_ups (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null,
  conversation_id     uuid,                                   -- the ticket it belongs to, when known
  kind                text not null check (kind in ('promise', 'document', 'repeat_ask')),
  source_message_id   uuid not null,                          -- client_messages.message_id it was found in
  item                text not null check (char_length(item) between 1 and 300),
  due_at              timestamptz,                            -- promise: deadline. document: first chase time.
  status              text not null default 'open' check (status in ('open', 'done', 'missed', 'cancelled')),
  resolved_at         timestamptz,
  resolved_by         text,                                   -- email of the person, or 'ai'
  resolved_message_id uuid,                                   -- message that delivered it (ai)
  resolved_upload_id  uuid,                                   -- document_uploads.upload_id that delivered it (ai)
  reminder_count      integer not null default 0,
  last_reminded_at    timestamptz,
  escalated_at        timestamptz,
  created_at          timestamptz not null default now(),
  constraint follow_ups_source_kind_item_key unique (source_message_id, kind, item)
);

create index if not exists follow_ups_client_open_idx on public.follow_ups (client_id, status, due_at);

alter table public.follow_ups enable row level security;
revoke all on public.follow_ups from anon, authenticated;

-- Check after running:
--   select count(*) from public.follow_ups;   -- 0
--   select relrowsecurity from pg_class where relname = 'follow_ups';   -- true

-- ROLLBACK (drops the table and every follow-up recorded):
--   drop table if exists public.follow_ups;
