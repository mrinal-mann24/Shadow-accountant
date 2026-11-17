# integrator notes

Status: DONE. From the repo root, after all changes: `npm run lint` clean, `npm run typecheck` clean,
`npm run test` 31 files / 353 tests pass, `npm run build` passes with no env set (21 routes + middleware).
Nothing was run against Supabase, OpenRouter, HubSpot, n8n or Vercel. No MCP tools used. No schema changes.

## Built
- `vercel.json`: crons health-score `30 1 * * *` (01:30 UTC = 7:00 am IST), council `*/15 * * * *` (default
  limit 25, no query string), hubspot-sync `*/30 * * * *`, embed `0 * * * *`.
- `README.md`: setup, commands, env table, Supabase Azure provider steps, roles, screens, jobs (dry-run curl
  commands, council eval), per-job checklist before writes, what is not done yet.
- `.env.example`: added `HUBSPOT_WON_STAGE_IDS`, `DEV_LOGIN_ROLE`, `JOBS_WRITE_ONLY`, clearer comments.
  Every `process.env` name used in the code is now listed.
- `CLAUDE.md`: Commands section filled in (dev, lint, typecheck, test, build; auth and job routes).
- `lib/jobs/guard.ts`: `jobsWriteEnabled(job?)` with optional `JOBS_WRITE_ONLY` narrowing (tests added).
- `lib/data`: `getCouncilUsage(user, windowDays)` (engineer only), `SystemHealth.lastCouncilVerdictAt`,
  `TeamOverview.hubspotLastSync`; pure verdict summary moved to `lib/data/usage.ts`; tests added.
- Admin / engineer pages switched to those; `components/engineer/council-usage.ts` deleted (as requested).
- Nav: admin gets `Assignment` (`/admin/assignment`) and `Users and roles` (`/admin/users`), matching the Admin tabs.
- Client 360 timeline rows carry `id="message-<id>" | "file-<id>" | "meeting-<id>" | "ticket-<id>"` so Ask AI
  citation links scroll to the source (`ActivityFeed` prop `anchors`).
- `app/api/jobs/hubspot-sync/route.ts`: same shape as the other job routes (500 JobResult on throw, `maxDuration`).
- `lib/data/types.ts` re-exports `Direction` from `lib/team/phone` instead of declaring it twice.

## Exports
```ts
import { jobsWriteEnabled } from '@/lib/jobs/guard'
jobsWriteEnabled(job?: string): boolean
// false unless JOBS_WRITE_ENABLED=true. If JOBS_WRITE_ONLY (comma list) is set, only listed jobs return true and
// a call without a job name returns false. Job names: 'health-score' | 'council' | 'hubspot-sync' | 'embed'.
import { getCouncilUsage, type CouncilUsageReport } from '@/lib/data'
getCouncilUsage(user: AppUser, windowDays = 30): Promise<CouncilUsageReport>   // engineer only, read-only
import { summariseVerdicts, percentile, type VerdictRow, type CouncilUsage } from '@/lib/data/usage'   // pure
// SystemHealth.lastCouncilVerdictAt: string | null;  TeamOverview.hubspotLastSync: string | null
```

## Decisions
- One global write switch was too coarse: the embed job and HubSpot each need separate approval, so turning on
  the council would also have turned them on. `JOBS_WRITE_ONLY` only narrows; it can never enable writes. Every
  route (and the HubSpot webhook, as `hubspot-sync`) passes its job name. The engineer page shows which jobs write.
- Cron times follow the integrator task (health-score 01:30 UTC, hubspot-sync every 30 min, embed hourly), not the
  agents' suggestions (19:00 UTC, every 15 min, every 30 min). Job hints on `/engineer` show the same schedules.
- Council cron has no `?limit=` in the path; the job's default is already 25.
- Kept `proxy.ts (was middleware.ts)` (contract name; Next 16 only warns). Renaming to `proxy.ts` is safe later.
- Did not unify `formatDateTime` / `formatAgo` / `formatMinutes` / `PageHeader` / `EmptyState` between
  `components/accountant` and `components/admin`: their output differs on purpose (blank vs "Never", "1 day ago"
  vs "1 d ago") and both are tested. Merging would change visible copy for no functional gain.
- Security lock-down (ROADMAP stage 1) skipped, as the user asked. Data access rule (service role through
  `lib/data`, scoped by AppUser) unchanged.

## Requests
- human (approval in chat, live setup): Supabase Azure provider and redirect URLs; Vercel project with the env
  names in `.env.example` (Pro plan for sub-daily crons); HubSpot private app scopes, five `va_*` Deal properties
  and webhook subscriptions; settings row `team_whatsapp_numbers`. Steps are in README.md.
- human (before writes, per job): see the "Turning writes on" table in README.md (unique constraint check on
  `client_score_history`, old council off, council eval, HubSpot dry-run review, embed approval).
- data (optional, still open): `lastMessageDirection` / last file date and an open SLA-breach count on
  `ClientListItem`.
- hubspot / leadership: bucket picker on Client 360 once `client-bucket.sql` is approved.
- council (later): token counts per call for AI cost (needs a schema proposal first).

## Known gaps
- Not verified live: sign-in, every Supabase query, OpenRouter and HubSpot calls, and the screens in a browser.
- Vercel Cron with `*/15` and `*/30` needs a Pro plan; crons run only on production.
- No CI workflow, no Vercel project, no git commit.
- `npm audit`: 7 moderate in dev-only lint tooling (unchanged from foundation).
- Citation anchors only exist for items in the latest 100 timeline rows on Client 360.
