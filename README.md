# Shadow Accountant

Ops platform for AI Accountant's Virtual Accounting practice: one timeline per client, AI ticketing from
WhatsApp (the ticket council), a daily health score, HubSpot two-way sync, role-based screens and a
client-scoped AI chat with citations.

Background and decisions: `docs/CONTEXT.md`. Build order: `docs/ROADMAP.md`. Working rules: `CLAUDE.md`.
Build contracts and each part's notes: `docs/agents/CONTRACTS.md` and `docs/agents/notes/`.

## Stack

Next.js 16 (App Router) + TypeScript, Tailwind CSS v4 + shadcn/ui, Supabase ("Supabase VA") for auth and data,
Vercel AI SDK 7 + OpenRouter for the council, embeddings and chat, Vitest for tests. Hosted on Vercel.

## Local setup

Needs Node 20.9 or newer (tested on Node 24).

```bash
npm ci
cp .env.example .env.local      # then fill in the values (see Environment)
npm run dev                     # http://localhost:3000
```

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm run dev`       | Dev server                                                           |
| `npm run lint`      | ESLint (flat config, eslint-config-next)                             |
| `npm run typecheck` | `tsc --noEmit`                                                       |
| `npm run test`      | Vitest, node environment, pure functions and fakes only (no network) |
| `npm run build`     | Production build; works with no env set                              |

Dev login (local only): set `DEV_LOGIN_EMAIL` (and optionally `DEV_LOGIN_ROLE`) in `.env.local`. The login page
then shows a "Dev login as ..." button. It is ignored whenever `NODE_ENV` is `production`. The dev identity id is
`dev-login:<email>`, not a uuid.

## Environment

Names only live in `.env.example`; never commit values. Set the same names in Vercel (Production and Preview).

| Name                                                                                | Needed for                                                             | Notes                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`                                                          | everything                                                             | Supabase project URL                                                                                                                                                                  |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                                                     | everything                                                             | Used for auth only (sign in, session)                                                                                                                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`                                                         | everything                                                             | Server only. All data reads and writes go through `lib/data` with this key, scoped by the signed-in user                                                                              |
| `OPENROUTER_API_KEY`                                                                | council, chat, embed                                                   |                                                                                                                                                                                       |
| `OPENROUTER_MODEL_A`                                                                | council, chat                                                          | Anthropic model id, for example `anthropic/claude-sonnet-5`. No default in code                                                                                                       |
| `OPENROUTER_MODEL_B`                                                                | council                                                                | Second council model, for example `openai/gpt-5.6-luna`                                                                                                                               |
| `OPENROUTER_EMBED_MODEL`                                                            | embed, vector search                                                   | Must return 1536 dimensions (`vector(1536)`), for example `openai/text-embedding-3-small`                                                                                             |
| `CRON_SECRET`                                                                       | every job route                                                        | Job routes reject every request when it is unset. Vercel Cron sends `Authorization: Bearer $CRON_SECRET` once it is set in the project                                                |
| `JOBS_WRITE_ENABLED`                                                                | every job and the HubSpot webhook                                      | Writes happen only when this is `true` and the job is in `JOBS_WRITE_ONLY`. Default: dry-run                                                                                          |
| `JOBS_WRITE_ONLY`                                                                   | every job and the HubSpot webhook                                      | Comma list of the jobs allowed to write: `health-score`, `council`, `hubspot-sync` (also the webhook), `embed`, `teams-notify`, `follow-ups`, `style-guides`. Blank means no job writes (fails closed), so each job has to be named |
| `STYLE_GUIDE_MODEL`                                                                 | `style-guides` job, `scripts/style-guide.ts`                           | Model that writes each pilot client's style guide for Suggested reply. Default `anthropic/claude-opus-5.5`. The reply itself uses `OPENROUTER_MODEL_A`                                     |
| `COUNCIL_START_DATE`                                                                | council                                                                | IST date `YYYY-MM-DD`. The council only reads messages from 00:00 IST that day; older ones are never voted on. Pilot demo: 30 days back. Go-live: the launch day. Blank reads every unprocessed message; a bad value fails the run |
| `HEALTH_SCORE_PILOT_ONLY`                                                           | health score                                                           | `true`: the daily run scores only clients with the council on (others have no tickets yet). Set `false` at go-live                                                                     |
| `TEAMS_BOT_APP_ID`, `TEAMS_BOT_APP_PASSWORD`, `TEAMS_BOT_TENANT_ID`                 | Teams bot (`/api/teams/messages`, `teams-notify` job)                  | Azure Bot app id, client secret value and tenant id. Missing values switch the bot off. See `teams-app/README.md`                                                                    |
| `HUBSPOT_ACCESS_TOKEN`                                                              | HubSpot sync                                                           | Private app token                                                                                                                                                                     |
| `HUBSPOT_WEBHOOK_SECRET`                                                            | HubSpot webhook                                                        | The HubSpot app's client secret (signature v3)                                                                                                                                        |
| `HUBSPOT_VA_PIPELINE_ID`, `HUBSPOT_VA_PAID_STAGE_ID`, `HUBSPOT_VA_ACTIVE_STAGE_IDS` | HubSpot sync                                                           | The VA client rule (`specs/hubspot-sync-v2.md`). Blank uses the live portal's ids: Virtual Accounting pipeline, Payment Done, and Payment Done / Ready for Renewal / Renewal Done     |
| `HUBSPOT_IGNORE_DEAL_IDS`                                                           | HubSpot sync                                                           | Deals never treated as clients (test deals)                                                                                                                                           |
| `HUBSPOT_PUSH_ENABLED`                                                              | HubSpot sync                                                           | `true` pushes the `va_*` deal properties. Keep `false` until those properties exist in HubSpot                                                                                        |
| `DEV_LOGIN_EMAIL`, `DEV_LOGIN_ROLE`                                                 | local only                                                             | Leave blank in Vercel                                                                                                                                                                 |
| `APP_TIMEZONE`                                                                      | scoring, chat, Draft reply, the "first reply in business hours" metric | Default `Asia/Kolkata`. The SLA itself is clock time, 24x7                                                                                                                            |
| `NEXT_PUBLIC_SITE_URL`                                                              | Microsoft sign-in                                                      | The deployed app's URL, used for the sign-in redirect instead of request headers. Blank locally                                                                                       |

## Supabase Auth: Microsoft (Azure) sign-in

Done once, in the dashboards, by someone with access. Nothing in this repo changes Supabase settings.

1. **Azure portal** (Microsoft Entra ID, App registrations, New registration):
   - Supported account types: this organisation's directory only (single tenant).
   - Redirect URI (Web): `https://<supabase-project-ref>.supabase.co/auth/v1/callback`.
   - Certificates and secrets: create a client secret and note it with the Application (client) id and the
     Directory (tenant) id.
   - API permissions: Microsoft Graph delegated `openid`, `email`, `profile` (the app asks for these scopes).
2. **Supabase dashboard**, Authentication, Sign In / Providers, Azure: enable it, paste the client id and secret,
   and set the Azure Tenant URL to `https://login.microsoftonline.com/<tenant-id>`.
3. **Supabase dashboard**, Authentication, URL Configuration:
   - Site URL: the production URL.
   - Redirect URLs: `https://<production-host>/auth/callback`, the preview pattern
     (for example `https://*-<team>.vercel.app/auth/callback`) and `http://localhost:3000/auth/callback`.
4. **Roles**: an Admin sets roles on the Users and roles page (`/admin/users`), which writes `app_metadata.role`
   (`senior_accountant`, `admin` or `engineer`). Someone whose login email matches `vas.email` gets
   `senior_accountant` without a role being set. Anyone else sees "Your account is not set up yet". The very
   first Admin has to be given `app_metadata.role = 'admin'` in the Supabase dashboard (Authentication, Users).
5. **Only Microsoft sign-in is trusted.** The app gives access only to accounts whose identities are all `azure`
   and whose email is confirmed (`email_confirmed_at`); anything else sees "not set up yet". Supabase VA is
   shared with other tools, so in the Supabase dashboard turn off email sign-ups (and any other provider) or at
   least keep auto-confirm off. Check after the first Microsoft sign-in that the user shows a confirmed email: if
   Supabase marks Azure emails as unconfirmed, add the optional `xms_edov` claim (email domain verified) to the
   Azure app's token configuration. The `vas.email` mapping decides whose clients an accountant sees; the anon key
   can no longer read or write `vas` or any client data (applied 17 Nov 2026, `supabase/applied/2026-11-17-lock-anon-access.sql`).

Routes: `/login`, `/auth/callback` (code exchange), `/auth/sign-out` (POST).

## Screens

| Route                                         | Who                                    | What                                                                                          |
| --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/home`                                       | everyone                               | KPIs, my open tickets by SLA, clients by bucket, today's activity                             |
| `/clients`, `/clients/<id>`                   | everyone (own clients for accountants) | Client list and Client 360 (health, tickets, files grid, timeline, profile, meetings)         |
| `/tickets`                                    | everyone                               | Ticket list with close, reopen and tag (accountants and admins). Pilot clients also get a Suggested reply in the panel (below) |
| `/ask`                                        | everyone                               | AI chat over the user's own clients, every claim cited                                        |
| `/admin`, `/admin/assignment`, `/admin/users` | admin (engineer sees Team only)        | Team workload, client assignment, users and roles                                             |
| `/engineer`                                   | engineer                               | Data sources, failed processing with retry, council on / off, job commands, AI usage, view as |

## Scheduled jobs

All four are `GET` (and `POST`, except HubSpot sync) routes that need `Authorization: Bearer $CRON_SECRET` and
return a JSON `JobResult`: `{ job, dryRun, processed, written, errors, details }`. Read `details` on dry runs: it
shows exactly what a write run would change.

| Job            | Route                                        | Schedule (`vercel.json`, UTC) | Writes in write mode                                                                                                                                                                                                           |
| -------------- | -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Health score   | `/api/jobs/health-score[?clientIds=a,b]`     | `30 1 * * *` (7:00 am IST)    | `client_scores`, `client_score_history`                                                                                                                                                                                        |
| Ticket council | `/api/jobs/council[?limit=25&clientIds=a,b]` | `*/15 * * * *`                | `council_verdicts`, `conversations`, `client_messages.conversation_id` / `processed_at`, `message_processing_log`                                                                                                              |
| HubSpot sync   | `/api/jobs/hubspot-sync`                     | `*/30 * * * *`                | `clients.deal_stage` (label), `clients.amount_paid`, `clients.status` (Active / Inactive), new clients for active VA deals, settings `hubspot_last_sync`; HubSpot `va_*` deal properties only when `HUBSPOT_PUSH_ENABLED=true` |
| Embeddings     | `/api/jobs/embed[?limit=1..100]`             | `0 * * * *`                   | `client_messages.embedding`                                                                                                                                                                                                    |
| Follow-ups     | `/api/jobs/follow-ups`                       | `5,20,35,50 * * * *`          | `follow_ups` (promises, document requests, repeat asks), settings `follow_ups_scan`, Teams reminder and escalation cards (`teams_notifications`). Pilot clients only (council on), from `COUNCIL_START_DATE`. Needs `supabase/applied/2026-11-18-follow-ups.sql` applied |
| Style guides   | `/api/jobs/style-guides[?clientIds=a,b&force=1]` | `0 22 * * *` (3:30 am IST) | settings `reply_style_guide:<client_id>` for the Suggested reply pilot clients (settings `reply_pilot_clients`): rebuilt when missing or 7+ days old, from the latest chat plus accountants' edits to suggested replies. A dry run makes no model calls. Needs `supabase/proposals/reply-suggestions.sql` run |

### Suggested reply (AI reply drafts pilot)

For a pilot client's open ticket where the client is waiting on us, the Tickets panel shows a reply written in that
client's style (its style guide, the measured v3 drafting rules in `lib/reply/suggest-prompt.ts`, the 15 messages
before the question and the latest accountant edits). Nothing is sent: the accountant edits it and copies it into
WhatsApp. Every suggestion and what was done with it (copied, edited, discarded) is saved in `reply_suggestions`;
edits go into the next drafts straight away and into the daily `style-guides` rebuild. Opening the ticket again
shows the same suggestion until the client writes again (Regenerate writes a new one).

Setup, once: run `supabase/proposals/reply-suggestions.sql` (the table and the pilot list), then either let the
`style-guides` job build the guides (add `style-guides` to `JOBS_WRITE_ONLY`) or seed the guides the accountants
reviewed: `npx tsx --conditions=react-server --env-file=.env.local scripts/style-guide.ts --group <id> --sql` writes
`style-guides/<slug>.seed.sql` (git-ignored) to run in Supabase. Until then the box stays hidden.
Measuring a change to the rules: `scripts/draft-test.ts` (80 held-back questions from the 4 pilot clients).

The HubSpot webhook (`POST /api/webhooks/hubspot`) checks the v3 signature and runs the sync for only the deals
in the payload; it follows the same write switch as `hubspot-sync`.

Vercel Cron schedules more often than once a day need a Vercel Pro plan. Crons run only on the production
deployment.

### Run a job by hand (dry run)

With `JOBS_WRITE_ENABLED` unset or `false` (or the job not in `JOBS_WRITE_ONLY`), every run is a dry run and only
reports. Job routes return 500 when the run failed (a fatal step, a write run that wrote nothing, or every item
failing) and 200 for partial per-item errors, so cron logs show failures.

```bash
export CRON_SECRET=...            # same value as in .env.local; never paste it into chat or tickets
BASE=http://localhost:3000        # or the deployed URL
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/jobs/health-score?clientIds=<id1>,<id2>"
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/jobs/council?limit=5"          # lists messages only
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/jobs/council?limit=5&vote=1"   # also calls both models
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/jobs/hubspot-sync"
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/jobs/embed?limit=10"
```

Dry runs still read Supabase and HubSpot. The council dry run lists the messages it would vote on and makes no
model call unless `?vote=1` is added (then it costs tokens), so the 15 minute cron is free while writes are off;
the embed dry run only counts and makes no model call. A council run stops starting new messages after about
150 seconds and then runs SLA marking, so it stays inside the 300 second limit. The System page (`/engineer`) shows the same commands with the right host.

Council evaluation (read only, run by a human; needs `tsx`, which is not in `package.json`):

```bash
npx tsx --conditions=react-server --env-file=.env.local scripts/council-eval.ts --offline
npx tsx --conditions=react-server --env-file=.env.local scripts/council-eval.ts --limit 50
```

### Turning writes on

Writes need explicit approval in chat for each job (`CLAUDE.md` hard rules). Turn them on one job at a time with
`JOBS_WRITE_ENABLED=true` plus `JOBS_WRITE_ONLY=<job>`, then add the next job to the list once it is checked. A
blank `JOBS_WRITE_ONLY` means no job writes.

| Job          | Before writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| health-score | Read-only check that `client_score_history` has a unique constraint on `(client_id, score_date)`. Dry run on a few clients, compare with an accountant's ranking, and get the formula signed off (ROADMAP stage 5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| council      | Confirm the old council is switched off, confirm `settings.sla_minutes`, run `council-eval.ts --offline` and `--limit 50`, and agree the agreement bar (ROADMAP stage 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| hubspot-sync | Private app scopes `crm.objects.deals.read`, `crm.schemas.deals.read` and `crm.objects.owners.read` (add `crm.objects.deals.write` only if push is approved later). Webhook subscriptions `deal.creation` and `deal.propertyChange` for `dealstage` and `amount_paid`, to `https://<host>/api/webhooks/hubspot`. Every run reconciles all paid deals in the VA pipeline (about 65), so a missed webhook heals on the next run. Review a dry run's `details.pull`: `counts`, `updates` (stage label, `amount_paid`, Active / Inactive), `creates` and `needsReview` (an active deal whose client exists under a similar name without `hubspot_deal_id`: link it by hand). At most 10 clients are created per run; more creates none and reports an error. Push stays off (`HUBSPOT_PUSH_ENABLED=false`) |
| embed        | Approved 17 Nov 2026 together with vector search (`public.match_client_messages`). Credentials are masked before any text goes to the embedding model. Check that `OPENROUTER_EMBED_MODEL` returns 1536 dimensions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Team numbers: the settings row `team_whatsapp_numbers` (30 numbers on 17 Nov 2026: every connected Periskope phone
plus current and former team members) together with `vas.whatsapp_number`. A new team phone must be added there,
otherwise its replies count as client messages.

## Data access rule

Until RLS policies for `authenticated` are approved (`supabase/proposals/rls-authenticated.sql`), the browser never
reads Supabase. Every screen reads and writes through `lib/data/*` on the server with the service-role key, and every
function scopes by the signed-in user (a Senior Accountant only gets clients where `clients.va_id` is theirs; "view
as" is read only). Jobs and agents have their own server-only stores (`lib/council/store.ts`, `lib/agent/store.ts`,
`lib/scoring/job.ts`, `lib/hubspot/sync.ts`, `lib/metrics/load.ts`, `lib/team`): the chat agent scopes every query to
the user's client ids; jobs run without a user and are protected by `CRON_SECRET`. The anon key can read nothing
except the view `clients_meeting_picker`.
Credential values (OTPs, passwords, login ids, account and card numbers) are masked by `lib/ai/redact.ts` in every
mapper that feeds a screen and in everything sent to a model.
SQL waiting for approval lives in `supabase/proposals/`; SQL that was approved and applied (with its rollback) lives in
`supabase/applied/`. Rollback exports with ids or phone numbers stay out of git (`.gitignore`).

## What is not done yet

- **RLS for logged-in users is not applied** (`supabase/proposals/rls-authenticated.sql`). The anon lock-down is
  done (17 Nov 2026), so today access control lives in the server code described above.
- No job has written yet (all dry runs); council is enabled for no client until the pilot. Microsoft sign-in end to
  end is unverified, and no screen has been opened by an accountant against real data.
- No Vercel project and no CI workflow yet. Code is committed on `master` (local).
- Proposals waiting for approval: `client-bucket.sql` (bucket column; the bucket switch stays disabled and
  `va_bucket` is not pushed) and `rls-authenticated.sql`.
- Bucket list (YTRO, DC, DS) awaits leadership confirmation.
- Files have no SharePoint links (`document_uploads` has no URL column). Meetings are not linked to clients yet.
- AI cost is not tracked (no token counts stored); no per-user rate limit on Ask AI or Draft reply.
- Public holidays are not excluded from the "first reply in business hours" metric.
- Ask AI search is full text until the embed job has written embeddings; then vector search adds relevance.
- `npm audit` reports 7 moderate findings in dev-only lint tooling (via eslint-config-next).
