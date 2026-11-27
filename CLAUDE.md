# Shadow Accountant

Ops platform for AI Accountant's Virtual Accounting (VA) practice (about 88 Indian SMB clients).
One timeline per client (WhatsApp, Drive, email, meetings, tickets), AI ticketing from WhatsApp,
bucket changes synced to HubSpot, role-based dashboards, client-scoped AI chat with citations.

Full background, decisions and live state: `docs/CONTEXT.md`. Read it before any non-trivial task.
This repo starts fresh. Do not read, copy or reference the old `va-platform` folder, its specs or its
draft migration. Where `docs/CONTEXT.md` mentions `va-platform`, `specs/` or `0001_phase0_...sql`,
treat it as history only. New specs are written here in `specs/` as we go.
Build order and open decisions: `docs/ROADMAP.md`.

## Stack

- Next.js + TypeScript on Vercel, Tailwind + shadcn/ui
- Supabase project "Supabase VA" (single brain: every source writes there, UI and agents read from there)
- Vercel AI SDK + OpenRouter (Claude) for agents
- n8n (`n8n.aiaccountant.com`) is the collection layer; files land in SharePoint "VA Documents"
- Shadow Accountant is the source of truth for VA clients (16 Nov 2026 decision). HubSpot stays the sales CRM and
  feeds in only: VA pipeline deals that have paid (stage label, amount paid, Active / Inactive, new clients).
  Shadow owns the accountant, bucket, health and tickets. Pushing to HubSpot is off. Spec: `specs/hubspot-sync-v2.md`

## Hard rules (never break without explicit approval in chat)

- No new tables, views or columns. Propose any schema change and wait for approval.
- Never run migrations, DDL or data-changing SQL on production. Read-only queries are fine.
- Service role key is server-only. Until RLS for logged-in users is approved (`supabase/proposals/rls-authenticated.sql`),
  the browser never queries Supabase: every screen reads through `lib/data` (scoped by the signed-in user) and every
  agent or job store scopes by client id in code. The anon key can read nothing but the view `clients_meeting_picker`.
  Any new data function must take the user (or the client ids already checked for them) and scope by it.
- Health score and the ticket council are rebuilt in this repo, as scheduled batch jobs
  (overrides "find and extend the old council code" in `docs/CONTEXT.md`).
- Collection stays deterministic (fixed n8n flows). AI sits on top, never does collection.
- WhatsApp ingestion stays with the existing va-bot (Periskope to `client_messages` + files to SharePoint,
  service role, `dedup_hash` = WhatsApp message id). This repo only reads `client_messages`; it never
  writes or changes ingestion. No new n8n message webhook.
- Never read, copy, store or echo client passwords or credentials (e.g. the "VA_data_collection" sheet).
- n8n edits: describe as find & replace (node name, exact Find, exact Replace), never line numbers.
- Do not touch the live Drive workflow (`yshF9ho9UInnw5fx`) without a mapped plan and approval.
- No new dependencies without saying why.

## Roles (least access)

Senior Accountant: own clients only (`clients.va_id`). Admin: all clients and users. Engineer: all data + system.
Role in `app_metadata.role`; accountant mapping is login email = `vas.email`.

## Writing conventions

- Indian English. No em dashes in UI copy or docs.
- Brand (redesign v1, 26 Nov 2026): white cards on a `#F6F7F9` canvas, ink `#0B0D12`, grey `#666666` for meta,
  accent `#314DD0` for the one primary action. Geist for text, Geist Mono for numbers (next/font), Helvetica Neue as
  fallback. Tokens and motion utilities live in `app/globals.css`; motion must respect reduced motion.
- Every AI answer about a client cites its source (message + time, SharePoint link, meeting + minute). If not found, say so.

## How we work (every non-trivial task)

1. **Scope**: goal, constraints, success criteria. No code.
2. **Explore**: read the relevant code, schema and workflows. Return a report. No code.
3. **Plan**: steps with files, reason, risk and how each is verified. Wait for approval.
4. **Challenge**: review the plan as a staff engineer (over-engineering, wrong assumptions, security, simpler options).
5. **Build**: one step at a time, small diffs, follow existing patterns, stop after each step.
6. **Verify**: run the checks below and report real output. Never say "done" without evidence.
7. **Review**: independent review of the diff (fresh agent), findings as Critical / Important / Suggestion.
8. **Learn**: propose updates to this file or `docs/` for anything reusable. Nothing task-specific.

Extra for AI features: define inputs, expected output, failure cases and an eval set before building.
Extra for n8n / sync work: map triggers, inputs, outputs, retries, idempotency, duplicate events,
secrets and rate limits before changing anything.
Extra for database work: inspect schema and dependent queries (n8n, va-bot, dashboard, anon key users)
first; propose SQL with a rollback; never apply without approval.

## Commands

Next.js 16 app at the repo root (`app/`, `components/`, `lib/`). Setup, env and jobs: `README.md`.

- `npm run dev` (http://localhost:3000)
- `npm run lint`
- `npm run typecheck`
- `npm run test` (Vitest, node only)
- `npm run build` (works with no env set)

Auth routes: `/login`, `/auth/callback`, `/auth/sign-out`. Job routes: `/api/jobs/{health-score,council,hubspot-sync,embed,teams-notify,follow-ups,style-guides}`
(Bearer `CRON_SECRET`, dry-run unless `JOBS_WRITE_ENABLED=true` and the job is listed in `JOBS_WRITE_ONLY`; a blank list means no job writes).
Build contracts and per-agent notes: `docs/agents/`.

## Before saying a task is complete

1. Run lint, typecheck, tests and build (whatever exists) and show the result.
2. List changed files.
3. State what was not verified and any remaining risk.
