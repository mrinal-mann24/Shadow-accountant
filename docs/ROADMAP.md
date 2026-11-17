# Shadow Accountant roadmap

Last updated: 16 Nov 2026. Each stage is its own task and goes through the 8 steps in `CLAUDE.md`
(Scope, Explore, Plan, Challenge, Build, Verify, Review, Learn). Do not start a stage until the one
before it is verified.

## What already exists (do not rebuild)

- **va-bot** writes every WhatsApp message to `client_messages` (live, service role) and files to SharePoint.
- **n8n** copies client Google Drive files to SharePoint every hour.
- **Supabase VA** (`kxlrxqewcnwcstzvyrcr`) holds clients, accountants, messages, tickets, verdicts and scores.

## What this repo builds

The app, the ticket council, the health score, metrics, HubSpot sync and the AI chat. It reads
`client_messages`; it never writes to it except the council's `conversation_id` / `processed_at`.

## Known data facts (from Explore, 16 Nov 2026)

- 14,737 messages; last one stored today. `dedup_hash` is the WhatsApp message id (uppercase hex, 20 to 32 chars).
- Direction is wrong: 12,917 incoming vs 877 outgoing. Team replies from personal numbers are stored as
  incoming. `vas` has only 4 people; about 22 team numbers exist. Scoring is wrong until this is fixed.
- 912 old messages have no direction. Media is almost always typed as `chat`.
- Council is enabled for 1 client; about 775 messages ever processed. 0 messages embedded.
- Update 17 Nov 2026: council is enabled for no client (old council data for Ayurpet reset); 5 pilot clients will be
  enabled at launch. Vector search is applied (`supabase/applied/match-client-messages.sql`); 0 messages embedded
  until the embed job writes. The anon key is locked out of all client data (stage 1 lock-down done).
- 89 clients, 72 with a WhatsApp group, 75 linked to an accountant (`va_id`).

## Stages

| #   | Stage                         | What we build                                                                                                                                                                                                                            | Depends on                       | Done when                                                                                            |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 0   | **Foundations**               | git repo, Next.js + TS + Tailwind + shadcn scaffold, lint / typecheck / test / build scripts, Supabase client (server and browser), generated DB types, env setup, Vercel project                                                        | nothing                          | `npm run build` passes, CI green, types match the live schema                                        |
| 1   | **Security lock-down**        | Move the anon callers (meeting picker, old dashboard, onboarding form), then remove anon policies, enable RLS on `client_contacts` / `addition_charges`, revoke anon grants and default privileges, remove the `kb_*` password functions | 0, plus answers on who uses anon | anon can read nothing; advisors clean; nothing live broke                                            |
| 2   | **Auth and roles**            | Microsoft SSO through Supabase Auth, `app_metadata.role`, login email to `vas.email`, RLS policies per role (accountant sees own clients only)                                                                                           | 1                                | each role sees exactly its data, proven with a test per role                                         |
| 3   | **Data fixes**                | Team numbers list, direction derived from it (at read time in our layer, or a one-time backfill with approval), message type for media                                                                                                   | 0                                | outgoing share looks right on a sample checked by an accountant                                      |
| 4   | **Metrics**                   | SQL functions for first reply time (overall and business hours), answered within 7 days, proactive vs reactive, thanks count, ticket resolution time                                                                                     | 3                                | numbers match the baseline in `docs/CONTEXT.md` section 5 within an agreed tolerance                 |
| 5   | **Health score**              | Daily batch: service score (from metrics, SLA breaches, open escalations) + mood score (from ticket tone and tags), weights in `score_weights`, writes `client_scores` and `client_score_history`                                        | 4                                | eval: scores ranked by an accountant for 10 clients agree with ours; old and new compared for a week |
| 6   | **Ticket council**            | Scheduled batch over unprocessed messages: two models vote (new / continue / close / reopen), writes `council_verdicts` and `conversations`. Eval set built from the 508 existing verdicts and 71 tickets first                          | 3                                | agreement with the eval set above the agreed bar; cost per message known; old council switched off   |
| 7   | **Senior Accountant screens** | Home (KPIs, clients by bucket, my tickets with SLA, today feed) and Client 360 (profile, tickets, timeline, scores), ticket actions                                                                                                      | 2, 5, 6                          | an accountant can work a day of tickets in it                                                        |
| 8   | **Admin screens**             | Team KPIs, workload, escalations, lowest health, user and role management, client assignment                                                                                                                                             | 7                                | admin can reassign a client and it shows everywhere                                                  |
| 9   | **HubSpot sync**              | Deal won creates a client; bucket, accountant, health score, open tickets pushed to Deal properties. One owner per field                                                                                                                 | 2, 5                             | a bucket change in the app shows in HubSpot within minutes; no loops                                 |
| 10  | **Engineer screens**          | Data source status, failed jobs + retry, council on / off per client, AI usage and cost, "view as"                                                                                                                                       | 6                                | a failed job can be seen and retried from the UI                                                     |
| 11  | **Context agent**             | Embeddings for messages, meeting transcripts linked to clients, Drive files logged, client chat with citations                                                                                                                           | 2, 7                             | answers cite sources; says "not found" when it should; eval set passes                               |

Later: email collection, Granola meetings, compliance calendar, communication agent (approval before send).

## Decisions needed before each stage

| Stage | Question                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | What runs `ops.aiaccountant.com` and the meeting client picker, and which Supabase key do they use?                                                                 |
| 3     | Where do the ~18 extra team numbers live: new rows in `vas` (team members who are not accountants) or the `settings` table? Fix direction at read time or backfill? |
| 4     | Is adding SQL functions allowed under the "no new tables or views" rule?                                                                                            |
| 5     | What the old health score formula is, and who signs off the new one                                                                                                 |
| 6     | Where the old council runs today, so it can be switched off cleanly; which OpenRouter models                                                                        |
| 5, 6  | Scheduler for batch jobs: Vercel Cron or Supabase cron                                                                                                              |
| 7     | Full bucket list and meanings (YTRO, DC, DS, ...)                                                                                                                   |
