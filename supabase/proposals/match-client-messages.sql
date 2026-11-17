-- APPLIED on 17 Nov 2026 (user approved in chat: "Yes vector search we need only"). Checked after: anon cannot execute,
-- service_role can. Still needs the embed job to write embeddings before it returns anything (0 embedded today).
-- Owner: context-agent. Used by lib/agent/store.ts searchMessagesVector when VECTOR_SEARCH_APPROVED = true.
--
-- Why: PostgREST cannot order by pgvector distance, so semantic search over client_messages.embedding
-- (vector(1536), 0 rows embedded today) needs one read-only SQL function. Full-text search on body_tsv works
-- without it. Callers are server-only (service role) and always pass the client ids the AppUser may see.
--
-- Index: add only once a meaningful share of messages is embedded (an ivfflat index on an empty column is useless).
-- Not part of this proposal:
--   create index concurrently client_messages_embedding_hnsw on public.client_messages
--     using hnsw (embedding vector_cosine_ops);

create or replace function public.match_client_messages(
  query_embedding vector(1536),
  client_ids uuid[] default null,
  match_count int default 12
)
returns table (
  message_id uuid,
  client_id uuid,
  message_timestamp timestamptz,
  body text,
  sender_name text,
  sender_phone text,
  direction text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  select m.message_id, m.client_id, m.message_timestamp, m.body, m.sender_name, m.sender_phone, m.direction,
         1 - (m.embedding <=> query_embedding) as similarity
  from public.client_messages m
  where m.embedding is not null
    and m.client_id is not null
    and (client_ids is null or m.client_id = any (client_ids))
  order by m.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

-- Only the server (service role) calls it. No anon or authenticated access.
revoke all on function public.match_client_messages(vector, uuid[], int) from public, anon, authenticated;
grant execute on function public.match_client_messages(vector, uuid[], int) to service_role;

-- Check column types before applying (message_id / client_id assumed uuid, message_timestamp timestamptz):
--   select column_name, data_type, udt_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'client_messages';

-- Rollback:
--   drop function if exists public.match_client_messages(vector, uuid[], int);
