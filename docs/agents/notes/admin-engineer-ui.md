# admin-engineer-ui notes

Status: DONE (code and tests). Nothing run against live systems. At the end of this build, from the repo root:
`npm run typecheck` clean, `npm run lint` clean, `npm run test` 25 files / 283 tests pass (mine: 3 files, 25 tests).
`next build` not run (shared `.next`, other agents still building).

## Built
- `app/(app)/admin/page.tsx` (Team, `requireUser(['admin','engineer'])`): KPI row (clients, unassigned, open tickets,
  open escalations, SLA breaches, clients waiting for a reply, average health), workload per accountant table
  (clients, open tickets, escalations, SLA breaches, waiting for reply, avg health, plus an Unassigned row), open
  escalations list, lowest health (10), HubSpot sync status.
- `app/(app)/admin/assignment/page.tsx` (admin only): accountant chips with client counts, GET search `?q=`, client
  table with an accountant picker per row (saves on change, rolls back on error). Unassigned clients listed first.
- `app/(app)/admin/users/page.tsx` (admin only): every auth user, explicit role picker ("No role set" clears it),
  access today (effective role, "from email" when it comes from the vas email rule), accountant record, last sign in.
  Own row is disabled.
- `app/(app)/admin/actions.ts` ('use server'): `assignClientAction`, `setUserRoleAction`.
- `app/(app)/engineer/page.tsx` (engineer only): job mode badge (dry-run / writes ON), data sources (last WhatsApp
  message + 24 h count, last score run, last council verdict, last HubSpot sync, pending / failed processing, team
  numbers count, each with a "late" warning), failed processing table with Retry, council on / off per client,
  curl commands per job (health-score, council, hubspot-sync, embed) with `$CRON_SECRET` as a shell variable,
  AI usage for the last 30 days (verdicts, model calls, agreement, per model calls / avg / p95 latency, decisions;
  "Cost: Not tracked"), view-as selector (reuses `components/shell/view-as-selector.tsx`).
- `app/(app)/engineer/actions.ts` ('use server'): `retryProcessingAction`, `setCouncilEnabledAction`.
- `components/admin/`: `format.ts` (pure), `kpis.ts` (pure), `subnav.ts` (pure), `action-result.ts`,
  `states.tsx` (PageHeader, Stat, Section, EmptyState, LoadError, Subnav), `assign-select.tsx`, `role-select.tsx`.
- `components/engineer/`: `usage.ts` (pure), `job-hints.ts` (pure), `council-usage.ts` (server-only reader, see
  Decisions), `retry-button.tsx`, `council-toggle.tsx`.
- Tests: `components/admin/admin.test.ts`, `components/engineer/engineer.test.ts`, `app/(app)/admin/actions.test.ts`
  (all four server actions with mocked auth / data).

## Exports (exact import paths + signatures)
Nothing here is meant for other agents, except the generic display helpers if useful.
```ts
// app/(app)/admin/actions.ts ('use server', requireUser(['admin']))
assignClientAction(clientId: string, vaId: string | null): Promise<ActionResult>
setUserRoleAction(userId: string, role: Role | null): Promise<ActionResult>
// app/(app)/engineer/actions.ts ('use server', requireUser(['engineer']))
retryProcessingAction(messageId: string): Promise<ActionResult>
setCouncilEnabledAction(clientId: string, enabled: boolean): Promise<ActionResult>
// components/admin/action-result.ts
type ActionResult = { ok: true } | { ok: false; error: string }
toActionError(e: unknown): ActionResult
// components/admin/format.ts (pure, client-safe)
formatDateTime(iso, timezone = 'Asia/Kolkata'): string; formatAgo(iso, now): string; isStale(iso, now, maxMinutes): boolean
formatMinutes(min): string; formatScore(score): string; scoreClass(score): string
// components/engineer/council-usage.ts (server-only, engineer only)
loadCouncilUsage(user: AppUser, windowDays = 30): Promise<CouncilUsageReport>
```

## Decisions
- `requireUser` runs outside `try` in every action so its redirects are not swallowed. Errors: `ForbiddenError` /
  `ViewAsReadOnlyError` messages and the known "... not found." messages are shown as they are; anything else is
  logged and shown as "Something went wrong. Please try again." (no database text reaches the browser).
- Assignment and Users are admin only (their mutations are admin only in lib/data / lib/auth). Engineers see only
  the Team tab. The Admin pages have their own tabs (Team, Assignment, Users and roles), so the auth nav item
  `/admin/users` ("Users and assignment") still reaches both.
- Each engineer page section loads independently (`Promise.allSettled`) and shows its own error card, so one failed
  query does not blank the page.
- AI usage reads `council_verdicts` in `components/engineer/council-usage.ts` (service role, engineer role checked
  first, read-only, uses `fetchAll` from `lib/data/paginate`). lib/data has no getter for it; this is a temporary
  home until data adds one (see Requests). Cost is shown as "Not tracked": verdicts store model id and latency only.
  Model calls = verdicts x 2 (retries are not stored).
- HubSpot sync status on `/admin`: `hubspot_last_sync` is only readable through `getSystemHealth` (engineer only),
  so engineers see the time and admins see "not available on this page for admins yet". Engineer page always shows it.
- Job hints: the base URL comes from the request host header (display only); the secret is never rendered, the
  command uses `$CRON_SECRET`. The page states whether `jobsWriteEnabled()` is on.
- "Late" thresholds: WhatsApp 6 h (va-bot may be asleep), score 26 h, council verdict 2 h (only when some client
  has the council on), HubSpot 60 min, team numbers below 10 flagged.
- Team KPI "SLA breaches" sums `AccountantWorkload.slaBreachedOpen`, so breaches on unassigned clients are not counted.
- One primary (accent) button per screen: "Change assignment" on Team, "Search" on Assignment; everything else is
  outline / ghost.

## Requests
- data: please add `getCouncilUsage(user, windowDays)` (engineer only) to `lib/data`, and `lastCouncilVerdictAt` to
  `SystemHealth`. I will then delete `components/engineer/council-usage.ts` and call yours. The pure summary is in
  `components/engineer/usage.ts` (`summariseVerdicts`) and can move with it.
- data: please expose `hubspotLastSync` to admins (for example a field on `TeamOverview`), so `/admin` can show it.
- data (optional): open SLA-breached ticket count per client on `ClientListItem` would let the team KPI include
  unassigned clients.
- auth (optional): the nav item `/admin/users` is labelled "Users and assignment"; assignment now lives at
  `/admin/assignment` (linked by tabs on every Admin page). Either keep it, or add an "Assignment" item.
- integrator: no new env vars. Please run `next build` once all agents are done; I did not.
- council (later): token counts per call would let the AI usage card show cost. Needs columns on `council_verdicts`
  (a schema change, so a proposal first). Not proposed by me.

## Known gaps
- Not run in a browser or against live data. Pages are typechecked and linted only; the client components have no
  component tests (repo has no jsdom).
- Failed processing shows the newest 20 failures (what `getSystemHealth` returns) with a "Showing 20 of N" note.
- Council toggle table lists every client (about 89) with no search; fine at this size.
- Client names link to the accountant-ui Client 360 page (`/clients/[id]`, now built). No `loading.tsx` / `error.tsx` on my routes: each section renders its own error card instead.
