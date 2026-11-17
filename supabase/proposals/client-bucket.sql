-- PROPOSAL ONLY. NOT APPLIED. Needs approval in chat before anyone runs it.
-- Purpose: store the ops bucket (YTRO, DC, DS, ...) on clients so Shadow Accountant can own it and
-- push it to HubSpot as the Deal property va_bucket.
-- Bucket list and meanings are still to be confirmed with leadership; update the check list first.
-- Dependents checked: none read clients.bucket today (new nullable column, no default, no backfill).

begin;

alter table public.clients
  add column bucket text;

alter table public.clients
  add constraint clients_bucket_check
  check (bucket is null or bucket in ('YTRO', 'DC', 'DS'));

comment on column public.clients.bucket is
  'Ops bucket owned by Shadow Accountant; pushed to HubSpot deal property va_bucket.';

commit;

-- Rollback:
-- begin;
-- alter table public.clients drop constraint if exists clients_bucket_check;
-- alter table public.clients drop column if exists bucket;
-- commit;
