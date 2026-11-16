# scoring notes

Status: DONE. `npm run typecheck`, `npm run test` (whole repo at last run, 14 files, 147 tests; mine 2 files, 43 tests) and `npm run lint` pass.
Not run against live data (no Supabase calls while building).

## Built
- `lib/scoring/index.ts` (pure): `computeHealthScore`, `messageEvents`, `ticketEvents`, `pickPrev`, `dateInTimezone`,
  `weightsFromRows`, `DEFAULT_WEIGHTS`, `TONE_SCORES`. Tests: `lib/scoring/index.test.ts` (38 tests, fixtures).
- `lib/scoring/job.ts` (server-only): `runHealthScoreJob`. Replaces the dormant old score (last ran 18 Sep 2026,
  one client). Same tables (`client_scores`, `client_score_history`) and the same `score_weights` keys.
- `app/api/jobs/health-score/route.ts`: GET and POST, `assertCronAuth` first, `write = jobsWriteEnabled()`,
  optional `?clientIds=a,b`, returns `JobResult` JSON (500 with a JobResult when the job throws). Test: `route.test.ts`.

## Exports
```ts
import { computeHealthScore, messageEvents, ticketEvents, pickPrev, dateInTimezone, weightsFromRows,
  DEFAULT_WEIGHTS, TONE_SCORES, type ScoreEvent, type HealthScoreResult, type Contribution } from '@/lib/scoring'

computeHealthScore(input: { metrics: ClientMetrics; events: ScoreEvent[]; weights: Record<string, number>; now: Date;
  prev?: { service: number; mood: number } }): HealthScoreResult
type ScoreEvent =
  | { kind: 'lag'; at: Date; lagMinutes: number }          // at = first incoming message of the run
  | { kind: 'unanswered'; at: Date }
  | { kind: 'ticket'; at: Date /* opened_at */; tag: string | null; fault: string | null; open: boolean; clientTone: string | null }
type HealthScoreResult = { service_score: number; mood_score: number; prev_service: number | null; prev_mood: number | null
  service_delta: number | null; mood_delta: number | null; open_issues: number; complaints_7d: number; our_fault_7d: number
  unanswered_count: number; worst_lag_minutes: number | null; top_reasons: string[]
  contributions: { key: string; count: number; points: number }[] }   // contributions is not a column; dry-run review only
messageEvents(msgs: MetricMessage[], opts: { now: Date; slaMinutes: number }): ScoreEvent[]
ticketEvents(rows: { tag; fault; status; opened_at; client_tone }[]): ScoreEvent[]
pickPrev(row: client_scores row | null | undefined, now: Date, timezone: string): { service; mood } | undefined
dateInTimezone(d: Date, timezone: string): string   // 'YYYY-MM-DD'

import { runHealthScoreJob } from '@/lib/scoring/job'
runHealthScoreJob(o: { write: boolean; now: Date; clientIds?: string[] }): Promise<JobResult>
// details: { scoreDate, slaMinutes, windowDays, weights, rows: { client_id, score, history, contributions }[] }
```
Route: `GET|POST /api/jobs/health-score[?clientIds=a,b]` with `Authorization: Bearer <CRON_SECRET>`.

## Formula (also in the header comment of lib/scoring/index.ts)
Weights from `score_weights` (missing keys fall back to the current values: window_days 30, half_life_days 14,
lag_over_4h -2, lag_over_24h -6, unanswered -8, complaint_us -5, complaint_neither -1, complaint_client 0,
escalation_us -12, positive +3). `sla_minutes` from `settings` (default 60).

**Service**: `clamp(100 + sum(weight * decay(age)), 0, 100)`, rounded; `decay = 0.5 ^ (ageDays / half_life_days)`.
- Reply lag over 4h adds lag_over_4h; over 24h also adds lag_over_24h (cumulative: a 30h lag = -8). Wall-clock,
  in window only. Age is from the client's first message of that run.
- Currently unanswered incoming run older than sla_minutes adds `unanswered` with no decay (current state).
- Complaint adds complaint_<fault>. Escalation at our fault adds escalation_us; escalation at another fault adds
  complaint_<fault>. Missing or unknown fault counts as `neither`. Open complaints/escalations get no decay and
  count even if opened before the window; closed ones decay by age since opened_at and need to be in the window.
- Positive ticket adds `positive` (decayed). Neutral or untagged tickets add nothing to service.

**Mood**: decay-weighted average of `client_tone` for tickets opened in the window (happy 100, calm 80,
neutral 60, frustrated 30, angry 10; unknown tones ignored), 70 when none. When the client sent messages:
`mood = 0.8 * tone + 0.2 * thanks`, `thanks = min(100, 50 + 500 * thanksCount / incomingCount)`.
No tones and no incoming messages gives 70.

**Counters**: open_issues = open complaint/escalation tickets; complaints_7d = complaint/escalation opened in
the last 7 days; our_fault_7d = those with fault us; unanswered_count = unanswered events (0 or 1);
worst_lag_minutes = metrics.worstLagMin (includes the current wait), else the worst replied lag.

**top_reasons**: up to 3, grouped by weight key, most negative first, e.g. "2 replies took over 24 hours",
"1 message waiting for a reply", "1 escalation where we were at fault".

**prev / delta**: from the existing client_scores row. If that row was computed earlier the same IST day
(a re-run), its own prev_service / prev_mood are kept so the delta stays "since the last day".

## Decisions
- Lag and unanswered events are derived in scoring (`messageEvents`) from the same `MetricMessage[]`, because
  `ClientMetrics` only carries counts and decay needs ages. The run and lag definitions match lib/metrics.
- `computeClientMetrics` is still used for thanks, incoming count and worst lag.
- Scores and deltas are whole numbers (safe for integer or numeric columns).
- Job: one query each for weights, settings, clients, existing scores and conversations (`opened_at >= window
  start OR status = open`); messages per client through `loadClientMessagesForMetrics`. Per-client errors go
  to `errors` and the rest continue. Write mode upserts `client_scores` on `client_id`, then
  `client_score_history` on `client_id,score_date` (score_date = date in APP_TIMEZONE, default Asia/Kolkata).
  `written` = client_scores rows upserted.
- `clientIds` given: scores exactly those clients, even without a WhatsApp group.
- Route sets `dynamic = 'force-dynamic'` and `maxDuration = 300`.

## Requests
- hubspot: the typecheck error you noted in `lib/scoring/job.ts` (missing `@/lib/metrics/load`) is gone now that
  data has added `load.ts`; full `npm run typecheck` passes.
- data: `loadClientMessagesForMetrics` calls `getTeamNumbers()` once per client, so the job runs it about 88
  times per run. A cached team set (or an optional `team` argument) would cut that. Not blocking.
- integrator: add a daily cron for `/api/jobs/health-score` in `vercel.json` (suggest 00:30 IST = `0 19 * * *` UTC,
  after the day closes). No extra env vars needed beyond `CRON_SECRET`, `JOBS_WRITE_ENABLED`, `APP_TIMEZONE`.
- integrator: assumes a unique constraint on `client_score_history (client_id, score_date)` for the upsert
  (the old job used this table the same way). Verify read-only before turning writes on; if it is missing the
  history upsert errors and is reported in `errors` (client_scores still writes).
- hubspot / accountant-ui / admin-engineer-ui: read `client_scores.service_score` as the health score;
  `top_reasons` is a JSON string array.

## Known gaps
- Not verified against live data. Before enabling writes, run dry-run on a few clients and compare with an
  accountant's ranking (ROADMAP stage 5 eval). Formula needs sign-off (ROADMAP open decision for stage 5).
- An incoming run that started before the window and is still unanswered is not seen (messages are loaded
  for the window only).
- `sla_breached` on conversations is not used; lags come from messages.
