# fixer notes

Status: DONE. Run from the repo root after every change: `npm run lint` clean, `npm run typecheck` clean,
`npm run test` 31 files / 377 tests pass (was 353), `npm run build` passes with no env set.
I ran nothing against Supabase, OpenRouter, HubSpot, n8n or Vercel, used no MCP tools and made no schema changes.
The only SQL edit is to the proposal file `supabase/proposals/rls-authenticated.sql`, which has not been applied.

## Findings (each checked against the code before fixing)
| # | Finding | Result |
|---|---|---|
| 1 | Accountant scope granted from any Supabase session's email | **Fixed.** `isTrustedSessionUser` (lib/auth/roles.ts) gives access only when every identity on the account is `azure` and `email_confirmed_at` is set. `getIdentity()` otherwise returns no access. An Azure account with an email identity linked to it is rejected too, because its session could come from that identity. The RLS proposal's two email rules now also require `app_metadata.provider = 'azure'`, and it notes that anon write on `vas` must go in Stage 1. README Azure step 5 asks for email sign-ups to be turned off. I did not add a tenant id check (see gaps). |
| 2 | One write switch turns on every job | **Fixed (fail closed).** A blank `JOBS_WRITE_ONLY` now means no job writes, so every job must be listed by name. Updated the tests, `.env.example`, README and the engineer page copy. |
| 3 | Dead messages stall the council for good | **Fixed.** The council now reads candidates in pages of 300 (offset, ordered by `message_timestamp` then `message_id`), up to 10 pages. It skips dead and already-voted messages until it has `limit` live ones. If it reaches the page cap with only dead messages, it reports a `queue:` error, so the route returns 500 and the stall shows up. `processed_at` is not set on dead messages, so `retryProcessing` still works. Tests cover 400 dead messages at the head, and the page cap. |
| 4 | A failure after the verdict insert drops the decision | **Fixed.** 'new': the ticket is found or created first (an orphan is found by client, `opened_by` council and `opened_at` equal to the message time), and then the verdict is inserted with `final_conv_id` already set. The separate `setVerdictConversation` step is gone. continue / close / reopen: the verdict is still inserted first. The unstick path (`finishStoredVerdict`) re-applies the stored decision when the ticket's `last_message_at` is older than the message, then marks the message and sets its log to `done`. In write mode, a failed message blocks that client's later messages for the rest of the run, so they are handled in order. Tests fail `updateConversation`, `createConversation` and `markMessage` once each. |
| 5 | False SLA breach when our reply is not attached to the ticket | **Fixed.** Before a ticket is flagged, the job looks in `client_messages` (any processing state, effective direction from lib/team) for a team message in the window `(last_message_at, last_message_at + sla_minutes]`. Tickets answered in time are reported in `sla.answeredInTime` and not flagged. I skipped the suggested "skip clients with backlog" check: the reply check reads raw messages, so a reply still in the backlog already counts. |
| 6 | Council dry-run cron burns LLM calls | **Fixed.** A dry run calls the models only with `?vote=1`. Without it, the run lists the messages it would vote on (`details.wouldVote`) and makes no model call. The cron stays in `vercel.json` and costs nothing while writes are off. Updated the job hints and README. |
| 7 | 300 s maxDuration can kill the run before SLA marking | **Fixed.** Time budget `DEFAULT_BUDGET_MS = 150_000`: no new message starts after 150 s. One message can take about 125 s, so the run plus SLA stays under 300 s. `details.stoppedEarly.remaining` records what was left. SLA marking always runs. MAX_LIMIT stays 100 because the budget caps the real work. |
| 8 | Scoring conversations read not paginated (and hubspot sync.ts open tickets) | **Fixed.** Both reads now use `fetchAll` + `chunk` from `lib/data/paginate`, with `.order('id')`. |
| 9 | Job routes return 200 when the job failed | **Fixed.** New `jobHttpStatus(result)` in `lib/jobs/guard.ts`. It returns 500 when `result.fatal` is set, when a write run had errors and wrote nothing, or when every processed item failed. Otherwise it returns 200 (partial errors). All four job routes use it, embed included. `fatal` is set for a client_scores upsert failure, a missing HUBSPOT_ACCESS_TOKEN, a clients load error, a pull error and a push load error. |
| 10 | HubSpot 207 partial failures ignored | **Fixed.** `batchUpdateDeals` returns `{ updated, errors }` and reads `errors[]` from a 207 response. `pushDeals` adds each one to `result.errors`. |
| 11 | First write run creates a client for every deal ever won | **Fixed.** New pure `gateClientCreates` (lib/hubspot/mapping.ts). With no cursor (first sync, webhook included), the run creates nothing: it only updates clients, seeds the cursor and adds a warning. More than `MAX_CREATES_PER_RUN = 10` creates: the run creates none, reports an error and does not move the cursor. |

## Built / changed
- `lib/auth/roles.ts` (+ `isTrustedSessionUser`, `TRUSTED_PROVIDER`, `SessionUserLike`), `lib/auth/session.ts`,
  tests in `lib/auth/roles.test.ts`, `lib/auth/session.test.ts`.
- `supabase/proposals/rls-authenticated.sql` (proposal only; azure provider check added).
- `lib/jobs/guard.ts` (fail-closed `jobsWriteEnabled`, `jobHttpStatus`, `JobResult.fatal?`), `lib/jobs/guard.test.ts`.
- `app/api/jobs/{health-score,council,hubspot-sync,embed}/route.ts` (status from `jobHttpStatus`; council `?vote=1`),
  `app/api/jobs/health-score/route.test.ts`.
- `lib/council/store.ts`, `lib/council/job.ts`, `lib/council/job.test.ts` (rewritten fake store, 13 new tests).
- `lib/scoring/job.ts`, `lib/hubspot/client.ts`, `lib/hubspot/sync.ts`, `lib/hubspot/mapping.ts`,
  `lib/hubspot/client.test.ts`, `lib/hubspot/mapping.test.ts`.
- `components/engineer/job-hints.ts`, `app/(app)/engineer/page.tsx` (copy), `.env.example`, `README.md`.

## Exports (exact import paths + signatures)
```ts
import { jobsWriteEnabled, jobHttpStatus, type JobResult } from '@/lib/jobs/guard'
jobsWriteEnabled(job?: string): boolean   // true only if JOBS_WRITE_ENABLED=true AND job is in JOBS_WRITE_ONLY
jobHttpStatus(result: JobResult): number  // 500 | 200, see table row 9
type JobResult = { job; dryRun; processed; written; errors: string[]; fatal?: boolean; details?: unknown }

import { isTrustedSessionUser, TRUSTED_PROVIDER, type SessionUserLike } from '@/lib/auth/roles'
isTrustedSessionUser(u: { email_confirmed_at?; app_metadata?: { provider?; providers? }; identities?: { provider? }[] }): boolean

import { runCouncilJob, finishStoredVerdict, CANDIDATE_PAGE, MAX_CANDIDATE_PAGES, DEFAULT_BUDGET_MS } from '@/lib/council/job'
runCouncilJob(o: { write: boolean; limit: number; clientIds?: string[]; vote?: boolean; budgetMs?: number }, deps?): Promise<JobResult>
// details: { clients, outcomes, skipped, sla: { slaMinutes, breached, answeredInTime }, stoppedEarly?: { remaining },
//            wouldVote?: { message_id, client_id, at }[] (dry run without vote) }
// CouncilStore changes: pendingMessages(clientIds, limit, offset); existingVerdicts -> Map<id, { final_decision, final_conv_id }>;
//   + getConversation(id), findCouncilTicket(clientId, openedAt), messagesBetween(clientId, after, until);
//   slaCandidates -> { id, client_id, last_message_at }[]; setVerdictConversation removed.

import { gateClientCreates, MAX_CREATES_PER_RUN } from '@/lib/hubspot/mapping'
gateClientCreates<T>(creates: T[], o: { firstRun: boolean; cap?: number }): { allowed: T[]; held: number; reason: 'first_run' | 'over_cap' | null }
// lib/hubspot/client.ts: batchUpdateDeals(...) now returns Promise<{ updated: number; errors: string[] }>; + batchErrorText, type BatchError
```
HTTP: `GET|POST /api/jobs/council?limit=..&vote=1` (vote applies to dry runs only; write runs always vote).

## Decisions
- Auth rule applies to every Supabase session, admins and engineers too (the login page only offers Microsoft).
  Dev login is unchanged (local only).
- Dead messages are paged past rather than marked processed, so `processed_at` keeps meaning "the council handled
  it" and the engineer Retry button keeps working.
- The replay of a stored continue / close / reopen keeps the ticket's current summary, because the vote's summary
  is not stored. message_count is never bumped twice.
- If two messages from the same client have exactly the same timestamp and both vote 'new', the second one reuses
  the first one's ticket. This is the cost of finding orphan tickets without a schema change.
- The HubSpot over-cap case creates none of the clients (it does not create the first 10), and the cursor does not
  move, so the error repeats until someone checks.

## Requests
- human / integrator: `CLAUDE.md` line 69 says job writes are "optionally narrowed by `JOBS_WRITE_ONLY`". It is now
  required: a blank list means no job writes. I did not edit CLAUDE.md. Please change the wording to
  "dry-run unless `JOBS_WRITE_ENABLED=true` and the job is listed in `JOBS_WRITE_ONLY`".
- human (Supabase dashboard, needs approval): turn off email sign-ups and any provider except Azure in Supabase VA
  (or at least keep auto-confirm off). After the first Microsoft sign-in, check that the user's email shows as
  confirmed. If it does not, add the `xms_edov` optional claim in the Azure app, or nobody will get in. Stage 1:
  remove anon write on `vas`.
- council owner: no new env vars. Vercel cron unchanged. To see the council's votes on a dry run, call it with `&vote=1`.
- integrator: no new env vars from fixer.

## Known gaps
- Not verified live. Two behaviours still need a check on staging: Supabase's Azure user shape
  (`email_confirmed_at`, `identities`), and PostgREST `eq` on `opened_at` with the stored timestamp string.
- No Azure tenant id check in code. It relies on the single-tenant Tenant URL in the Supabase Azure provider.
- Tickets answered in time stay SLA candidates (last direction still incoming) and are checked again on every run:
  one small query each, capped at 1000 candidates per run.
- `sla_breached` is still never reset to false. It means "was breached at some point".
- A stray orphan ticket can stay if a create succeeded, the verdict insert failed, and the re-vote then did not
  choose 'new'. The re-vote sees that ticket as open, so it usually continues it.
