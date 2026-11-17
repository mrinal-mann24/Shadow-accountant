-- Proposal (not applied). Run by hand in the Supabase SQL editor after review.
-- Why: on 17 Nov 2026 the duplicate SharePoint folders were merged into each client's main folder.
-- These document_uploads rows still name the old duplicate folder. folder_name is a label only
-- (no file is moved by this SQL). Main folder = stored whatsapp_group_name, else client_name.
-- Touches 67 rows: WoolWorth 37, SLV 25, RapidFix 4, Umang 1.

-- 1. Check first and SAVE this output (it is the rollback list): expect 67 rows
select upload_id, client_id, folder_name
from document_uploads
where (client_id, folder_name) in (
  ('3618b8ee-1429-4304-b508-72b6a2aa197c'::uuid, 'WoolWorth_VA_2026'),
  ('8498157a-3fdc-4a23-9c09-7b2c747fe1d9'::uuid, 'SLV Trades and logistics_VA_2026'),
  ('3d1b7d53-cabb-436b-b257-1df31946a8a7'::uuid, 'RapidFix'),
  ('501abd6d-0e44-40fb-8643-fe68d6dc8a10'::uuid, 'Umang')
)
order by client_id;

begin;

-- 2. Point them at the main folder
update document_uploads d
set folder_name = trim(both E' \r\n' from coalesce(nullif(trim(c.whatsapp_group_name), ''), c.client_name))
from clients c
where c.client_id = d.client_id
  and (d.client_id, d.folder_name) in (
    ('3618b8ee-1429-4304-b508-72b6a2aa197c'::uuid, 'WoolWorth_VA_2026'),
    ('8498157a-3fdc-4a23-9c09-7b2c747fe1d9'::uuid, 'SLV Trades and logistics_VA_2026'),
    ('3d1b7d53-cabb-436b-b257-1df31946a8a7'::uuid, 'RapidFix'),
    ('501abd6d-0e44-40fb-8643-fe68d6dc8a10'::uuid, 'Umang')
  );
-- expect: UPDATE 67

-- 3. WoolWorth's stored group name ends with a stray line break ("Packworth group X VA" + CR LF).
--    va-bot already ignores it; this only cleans the value. The folder name does not change.
update clients set whatsapp_group_name = trim(both E' \r\n' from whatsapp_group_name)
where client_id = '3618b8ee-1429-4304-b508-72b6a2aa197c' and whatsapp_group_name like E'%\n';
-- expect: UPDATE 1

commit;

-- Rollback: for each saved row from step 1
--   update document_uploads set folder_name = '<old folder_name>' where upload_id = '<upload_id>';
-- and for step 3 (only if wanted):
--   update clients set whatsapp_group_name = whatsapp_group_name || E'\r\n' where client_id = '3618b8ee-1429-4304-b508-72b6a2aa197c';
