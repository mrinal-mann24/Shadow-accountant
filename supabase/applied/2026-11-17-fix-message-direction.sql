-- Proposal (not applied). Run by hand in the Supabase SQL editor after review.
-- Why: old client_messages rows from team numbers are stored as 'incoming' (va-bot only knew 4 team numbers until
-- 16 Nov 2026), and 912 old rows have no direction at all. Shadow already works out team vs client at read time,
-- so this is a data clean-up, not a blocker. Team = settings.team_whatsapp_numbers + vas.whatsapp_number
-- (last 10 digits), the same rule va-bot uses.
--
-- Counts on 17 Nov 2026 (with today's 10 team numbers): 5,586 incoming -> outgoing, 99 null -> outgoing,
-- 813 null -> incoming. Rows already 'outgoing' are never touched (they were sent from a connected Periskope phone).

-- ---------------------------------------------------------------------------------------------------------------
-- STEP 0 (only after you confirm who these are): add missing team numbers.
-- These numbers sent messages FROM a connected Periskope phone (so they are AIA phones) and post in several
-- unrelated clients' groups, but are not in the team list:
--   7338522425, 7411725500, 8050769512, 6364360114, 7204385841, 7204085862, 8904987623, 8123107947
-- These post in 3 to 5 unrelated clients' groups but never from a Periskope phone (confirm each):
--   9811285957, 9900566344, 7206871015, 9947816750, 8296472721
-- Edit the list below to the confirmed ones, then run:
-- update settings set value = value || ',7338522425,7411725500,8050769512,6364360114,7204385841,7204085862,8904987623,8123107947'
-- where key = 'team_whatsapp_numbers';
-- Rollback: update settings set value = '9741428606,6366983697,8904696503,6366869864,7349742762,9741429596'
--           where key = 'team_whatsapp_numbers';
-- (va-bot picks up the new list within 5 minutes; no redeploy.)
-- ---------------------------------------------------------------------------------------------------------------

-- STEP 1: preview and EXPORT this result as CSV (it is the rollback list).
with team as (
  select right(regexp_replace(x, '\D', '', 'g'), 10) n
  from settings, regexp_split_to_table(coalesce(value, ''), '[,;\s]+') x
  where key = 'team_whatsapp_numbers' and length(regexp_replace(x, '\D', '', 'g')) >= 10
  union
  select right(regexp_replace(whatsapp_number, '\D', '', 'g'), 10) from vas where whatsapp_number is not null
)
select m.message_id, m.direction as old_direction,
       case when t.n is not null then 'outgoing' else 'incoming' end as new_direction
from client_messages m
left join team t on t.n = right(regexp_replace(coalesce(m.sender_phone, ''), '\D', '', 'g'), 10)
where (m.direction = 'incoming' and t.n is not null) or m.direction is null;

-- STEP 2: apply (same selection as STEP 1).
begin;
with team as (
  select right(regexp_replace(x, '\D', '', 'g'), 10) n
  from settings, regexp_split_to_table(coalesce(value, ''), '[,;\s]+') x
  where key = 'team_whatsapp_numbers' and length(regexp_replace(x, '\D', '', 'g')) >= 10
  union
  select right(regexp_replace(whatsapp_number, '\D', '', 'g'), 10) from vas where whatsapp_number is not null
), fix as (
  select m.message_id, case when t.n is not null then 'outgoing' else 'incoming' end as new_direction
  from client_messages m
  left join team t on t.n = right(regexp_replace(coalesce(m.sender_phone, ''), '\D', '', 'g'), 10)
  where (m.direction = 'incoming' and t.n is not null) or m.direction is null
)
update client_messages m set direction = f.new_direction
from fix f where f.message_id = m.message_id;
-- expect: UPDATE = the row count of STEP 1 (6,498 with today's list; more if STEP 0 added numbers)
commit;

-- Rollback: for each row of the STEP 1 CSV
--   update client_messages set direction = <old_direction, or null> where message_id = '<message_id>';
