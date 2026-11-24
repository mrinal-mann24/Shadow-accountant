-- APPROVED 24 Nov 2026 in chat ("Yes, approve"). Not applied yet: run once in the Supabase SQL editor (Supabase VA),
-- then move this file to supabase/applied/. Rollback at the bottom.
--
-- What it stores: the text a client typed under a WhatsApp image or PDF ("October bill, please book it under AP").
-- Today va-bot saves that text only as a separate client_messages row with no link to the file, so the Teams
-- "new files" card cannot show it. With this column va-bot writes the text on the file's own row.
--
-- Who writes it: va-bot (live webhook, nightly catch-up, recovery). It names its insert columns, so the new
-- optional column changes nothing for older code. n8n's Drive workflow does not write this table.
-- Who reads it: Shadow's server code with the service role key (Teams file card). No view depends on
-- document_uploads; RLS is unchanged (on, no policies), so the anon key still reads nothing here.
--
-- ORDER: run this BEFORE deploying the Shadow change that reads the column (its select would fail without it).
-- va-bot retries without the caption if the column is missing, so its order does not matter.

alter table public.document_uploads add column if not exists caption text;

comment on column public.document_uploads.caption is
  'Text the sender typed under the file on WhatsApp (raw; mask credentials before showing). Null when there was none.';

-- Check:
-- select column_name, data_type, is_nullable from information_schema.columns
--  where table_schema = 'public' and table_name = 'document_uploads' and column_name = 'caption';

-- Rollback (deploy Shadow without the caption code first):
-- alter table public.document_uploads drop column if exists caption;
