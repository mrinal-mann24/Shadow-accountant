-- APPLIED on 17 Nov 2026 (user approved in chat: "Yes, apply it"). Checked after: conversations_tag_check now allows suspense.
-- Why: the Senior Accountant asked for a "Suspense" ticket tag: payments we cannot match yet (the bank shows 10 vendor
-- payments, receipts cover 7, so 3 are in suspense and we keep asking the client). The code already knows the tag
-- (lib/council/types.ts TAGS, the council prompt, the tag filter and badge), but conversations.tag has a check
-- constraint that allows only 4 values, so any 'suspense' ticket would be rejected until this runs.
-- Effect: allows one more value. No existing row changes. Health score treats 'suspense' as neutral (no penalty).

begin;
alter table public.conversations drop constraint conversations_tag_check;
alter table public.conversations add constraint conversations_tag_check
  check (tag = any (array['escalation'::text, 'complaint'::text, 'neutral'::text, 'positive'::text, 'suspense'::text]));
commit;

-- Rollback (only if no row uses 'suspense'; otherwise re-tag those rows first):
-- begin;
-- alter table public.conversations drop constraint conversations_tag_check;
-- alter table public.conversations add constraint conversations_tag_check
--   check (tag = any (array['escalation'::text, 'complaint'::text, 'neutral'::text, 'positive'::text]));
-- commit;
