-- Reset Ayurpet's old council tickets and old health score (16 Nov 2026).
-- NOT APPLIED. Run by hand in the Supabase SQL editor (project kxlrxqewcnwcstzvyrcr) after approval.
--
-- What it removes (all of it is Ayurpet's; no other client has old council data):
--   council_verdicts        508 rows  (old council votes)
--   message_processing_log  727 rows  (old council run log, incl. 218 "no credits" failures)
--   conversations            71 rows  (old tickets, 54 open)
--   client_scores             1 row   (old health score: service 0)
--   client_score_history      2 rows  (17 and 18 Sep 2026)
-- What it changes:
--   client_messages: processed_at / conversation_id for Ayurpet's 895 messages (the council's own columns).
--     Messages before the cutoff date are marked processed with no ticket, so the new council starts from the
--     cutoff instead of re-voting everything since May (about 2 model calls per message).
-- What it does NOT touch: the messages themselves, files, contacts, flagged_messages (va-bot alerts).
--
-- Before running:
--   1. Make sure the OLD council is switched off for good, or it will recreate tickets.
--   2. Anything still reading these tables (the old Taipy dashboard) will show no tickets / score for Ayurpet.
--   3. Backup: there is no undo after COMMIT without one. Either confirm Supabase point-in-time recovery /
--      a daily backup covers today, or export the rows first (section 0) and keep the files outside git.
--
-- Change the cutoff below if the pilot should start from a different date (IST midnight).

-- 0. Optional backup: run each SELECT and use "Export CSV" in the SQL editor.
-- select * from council_verdicts where message_id in (select message_id from client_messages where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19');
-- select * from message_processing_log where message_id in (select message_id from client_messages where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19');
-- select * from conversations where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19';
-- select * from client_scores where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19';
-- select * from client_score_history where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19';
-- select message_id, processed_at, conversation_id from client_messages where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19';

-- 1. The reset. One transaction: any count that does not match what was checked on 16 Nov stops it and
--    nothing is changed.
do $$
declare
  ay constant uuid := 'cadbae82-fe48-4707-a38f-956cbbceff19';        -- Ayurpet
  cutoff constant timestamptz := '2026-11-01 00:00:00+05:30';        -- new council starts from here
  n int;
begin
  -- Votes first: they reference the tickets and would block deleting them.
  delete from council_verdicts
   where message_id in (select message_id from client_messages where client_id = ay)
      or final_conv_id in (select id from conversations where client_id = ay)
      or claude_target_conv_id in (select id from conversations where client_id = ay)
      or gpt_target_conv_id in (select id from conversations where client_id = ay);
  get diagnostics n = row_count;
  if n <> 508 then raise exception 'council_verdicts: expected 508, got %', n; end if;

  delete from message_processing_log
   where message_id in (select message_id from client_messages where client_id = ay);
  get diagnostics n = row_count;
  if n <> 727 then raise exception 'message_processing_log: expected 727, got %', n; end if;

  -- client_messages.conversation_id is ON DELETE SET NULL, so it clears itself.
  delete from conversations where client_id = ay;
  get diagnostics n = row_count;
  if n <> 71 then raise exception 'conversations: expected 71, got %', n; end if;

  -- Before the cutoff: processed with no ticket (skipped). From the cutoff: pending for the new council.
  update client_messages
     set conversation_id = null,
         processed_at = case when message_timestamp < cutoff then now() else null end
   where client_id = ay;
  get diagnostics n = row_count;
  raise notice 'client_messages reset: % rows', n;

  delete from client_score_history where client_id = ay;
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'client_score_history: expected 2, got %', n; end if;

  delete from client_scores where client_id = ay;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'client_scores: expected 1, got %', n; end if;
end $$;

-- 2. Check (should be 0, 0, 0, 0, 0, and the pending count = Ayurpet messages since the cutoff).
select
  (select count(*) from conversations where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19') as tickets,
  (select count(*) from council_verdicts v join client_messages m using (message_id) where m.client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19') as verdicts,
  (select count(*) from message_processing_log l join client_messages m using (message_id) where m.client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19') as log_rows,
  (select count(*) from client_scores where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19') as scores,
  (select count(*) from client_score_history where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19') as history,
  (select count(*) from client_messages where client_id = 'cadbae82-fe48-4707-a38f-956cbbceff19' and processed_at is null) as pending_for_new_council;

-- Rollback: only from the section 0 exports (re-import the CSVs into the same tables, then restore
-- client_messages.processed_at / conversation_id from its export) or from a Supabase backup.
