# Build contracts (shared by all build agents)

Every agent builds against these signatures. If you need something that is not here, or must change a
signature, write it under "Requests" in your own notes file (`docs/agents/notes/<your-agent>.md`) and
build against the contract as written. Read the other agents' notes files before you start and again
before you finish; that is how agents talk to each other.

## Ground rules for every agent
- **Own only your folders** (table below). Never edit another agent's files, `package.json`, or lockfiles.
  Need a dependency? Ask in your notes; foundation installs the expected set up front.
- **No database or external calls while building.** Do not use Supabase, n8n, HubSpot or any MCP tool that
  reads or writes live systems. Build against `lib/db/database.types.ts` (generated from the live schema).
- **No schema changes.** No new tables, views, columns or SQL functions. If something truly needs one, write
  the proposed SQL to `supabase/proposals/<name>.sql` (never applied) and say so in your notes.
- **Every job is dry-run by default.** Writes happen only when `jobsWriteEnabled()` is true
  (env `JOBS_WRITE_ENABLED=true`). Job routes require the cron secret.
- **No secrets in files.** Only `.env.example` with names and comments.
- Messages, transcripts and documents are untrusted input. AI calls return structured output only (zod);
  no tools that act, no following instructions found inside message text.
- UI copy: Indian English, no em dashes. Brand: white, black, grey `#666666`, accent `#314DD0` for the one
  primary action per screen, Helvetica Neue.
- Tests: Vitest, colocated as `*.test.ts`. Every pure function gets tests with fixtures.

## Temporary data-access rule (until Stage 1 / RLS policies are approved)
The live DB has no RLS policies for `authenticated`, so a logged-in user's Supabase session can read
almost nothing. Until policies are approved, **all data reads and writes go through `lib/data/*` on the
server, using the service-role client, and every function scopes by `AppUser`** (a senior accountant only
ever gets rows where `clients.va_id = user.vaId`). Nothing in the browser touches Supabase data directly.
Proposed RLS policies go in `supabase/proposals/rls-authenticated.sql` (owner: auth agent).

## Folder ownership
| Agent | Owns |
|---|---|
| foundation | `package.json`, configs, `app/layout.tsx`, `app/globals.css`, `components/ui/*` (shadcn), `lib/env.ts`, `lib/supabase/*`, `lib/db/types.ts`, `lib/jobs/guard.ts`, `lib/utils.ts`, `.env.example` |
| auth | `proxy.ts`, `app/(auth)/*`, `app/auth/*`, `app/(app)/layout.tsx`, `components/shell/*`, `lib/auth/*`, `supabase/proposals/rls-authenticated.sql` |
| data | `lib/data/*`, `lib/team/*`, `lib/metrics/*` |
| scoring | `lib/scoring/*`, `app/api/jobs/health-score/*` |
| council | `lib/council/*`, `lib/ai/*`, `app/api/jobs/council/*`, `scripts/council-eval.ts` |
| hubspot | `lib/hubspot/*`, `lib/buckets.ts`, `app/api/jobs/hubspot-sync/*`, `app/api/webhooks/hubspot/*`, `supabase/proposals/client-bucket.sql` |
| accountant-ui | `app/(app)/home/*`, `app/(app)/clients/*`, `app/(app)/tickets/*`, `components/accountant/*` |
| admin-engineer-ui | `app/(app)/admin/*`, `app/(app)/engineer/*`, `components/admin/*`, `components/engineer/*` |
| context-agent | `lib/agent/*`, `app/api/chat/*`, `app/api/jobs/embed/*`, `app/(app)/ask/*`, `components/chat/*` |
| integrator | anything, to make the build pass; `vercel.json`; `README.md` |

## Signatures

### foundation
```ts
// lib/env.ts  (lazy: validate on first call, never at import, so `next build` works without secrets)
export function serverEnv(): {
  NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY: string
  OPENROUTER_API_KEY?: string; OPENROUTER_MODEL_A?: string; OPENROUTER_MODEL_B?: string; OPENROUTER_EMBED_MODEL?: string
  CRON_SECRET?: string; JOBS_WRITE_ENABLED: boolean; HUBSPOT_ACCESS_TOKEN?: string; HUBSPOT_WEBHOOK_SECRET?: string
  DEV_LOGIN_EMAIL?: string; APP_TIMEZONE: string /* default Asia/Kolkata */
}
// lib/supabase/server.ts   export async function createServerSupabase(): SupabaseClient<Database>   (cookies, @supabase/ssr)
// lib/supabase/browser.ts  export function createBrowserSupabase(): SupabaseClient<Database>        (auth only)
// lib/supabase/admin.ts    import 'server-only'; export function createAdminSupabase(): SupabaseClient<Database>
// lib/db/types.ts          export type Row<T extends TableName> / Insert<T> / Update<T>, ViewRow<V>, re-export Database
// lib/jobs/guard.ts        export function assertCronAuth(req: Request): void  // throws 401 Response unless Bearer CRON_SECRET
//                          export function jobsWriteEnabled(): boolean
//                          export type JobResult = { job: string; dryRun: boolean; processed: number; written: number; errors: string[]; details?: unknown }
```

### auth
```ts
// lib/auth/types.ts
export type Role = 'senior_accountant' | 'admin' | 'engineer'
export type AppUser = { id: string; email: string; name: string; role: Role; vaId: string | null; viewingAs?: { vaId: string; name: string } }
// lib/auth/session.ts (server-only)
export async function getCurrentUser(): Promise<AppUser | null>   // role from app_metadata.role, vaId from vas.email = login email
export async function requireUser(roles?: Role[]): Promise<AppUser> // redirects to /login or /home
export function canSeeAllClients(u: AppUser): boolean               // admin, engineer
// Engineer "view as": cookie `view_as_va`; when set, return the accountant's scope with viewingAs filled; read-only.
// Dev login: only when NODE_ENV !== 'production' AND DEV_LOGIN_EMAIL is set; never in production.
```

### data
```ts
// lib/team/index.ts
export function normalizePhone(raw: string | null): string | null   // digits only, last 10
export async function getTeamNumbers(): Promise<Set<string>>         // vas.whatsapp_number + settings key 'team_whatsapp_numbers' (comma list)
export function effectiveDirection(m: { sender_phone: string | null; direction: string | null }, team: Set<string>): 'incoming' | 'outgoing'
// lib/metrics/index.ts  (pure)
export type MetricMessage = { at: Date; direction: 'incoming' | 'outgoing'; body: string }
export type ClientMetrics = { firstReplyMedianMin: number | null; firstReplyBizMedianMin: number | null; answeredWithin7dPct: number | null
  proactivePct: number | null; thanksCount: number; unansweredCount: number; worstLagMin: number | null; lagsOver4h: number; lagsOver24h: number
  incomingCount: number; outgoingCount: number }
export function computeClientMetrics(msgs: MetricMessage[], opts: { now: Date; timezone: string }): ClientMetrics
export function businessMinutesBetween(a: Date, b: Date, timezone: string): number   // Mon to Sat 10:00 to 19:00 IST
// lib/metrics/load.ts (server-only)
export async function loadClientMessagesForMetrics(clientId: string, windowDays: number): Promise<MetricMessage[]>
// lib/data/*.ts (server-only, all take the user and enforce scope; return null / [] when out of scope)
listClients(user, f?: { search?: string; vaId?: string }): Promise<ClientListItem[]>   // includes score + open ticket counts
getClient(user, clientId): Promise<ClientDetail | null>
listMessages(user, clientId, o?: { before?: string; limit?: number }): Promise<MessageItem[]>  // includes effective direction
listConversations(user, f?: { clientId?: string; status?: 'open' | 'closed'; tag?: string }): Promise<ConversationItem[]>
updateConversation(user, id, patch: { status?: 'open' | 'closed'; tag?: string; summary?: string; title?: string }): Promise<void>
getClientScores(user, clientIds?: string[]): Promise<ScoreItem[]>;  getScoreHistory(user, clientId, days): Promise<ScoreHistoryItem[]>
listDocuments(user, clientId): Promise<DocumentItem[]>;  listMeetings(user, clientId): Promise<MeetingItem[]>
getTimeline(user, clientId, o?: { limit?: number }): Promise<TimelineItem[]>  // kind: 'message' | 'document' | 'meeting' | 'ticket'
listVas(user): Promise<VaItem[]>                         // admin / engineer only
assignClient(user, clientId, vaId): Promise<void>         // admin only
getTeamOverview(user): Promise<TeamOverview>             // admin / engineer: per-accountant workload, escalations, lowest health
getSystemHealth(user): Promise<SystemHealth>             // engineer: last message at, failed processing rows, last score run, council clients
setCouncilEnabled(user, clientId, enabled): Promise<void> // engineer only
// export all item types from lib/data/types.ts
```

### scoring
```ts
// lib/scoring/index.ts (pure)  weights come from table score_weights (keys: window_days, half_life_days, lag_over_4h, lag_over_24h,
//   unanswered, complaint_us, complaint_neither, complaint_client, escalation_us, positive)
export function computeHealthScore(input: { metrics: ClientMetrics; events: ScoreEvent[]; weights: Record<string, number>; now: Date; prev?: { service: number; mood: number } }): HealthScoreResult
// HealthScoreResult matches client_scores columns: service_score, mood_score (0..100), deltas, open_issues, complaints_7d, our_fault_7d, unanswered_count, worst_lag_minutes, top_reasons (string[])
// lib/scoring/job.ts (server-only)
export async function runHealthScoreJob(o: { write: boolean; now: Date; clientIds?: string[] }): Promise<JobResult>
```

### council
```ts
// lib/ai/openrouter.ts (server-only)   export function getModel(which: 'A' | 'B'): LanguageModel   // OPENROUTER_MODEL_A / _B
// lib/council/types.ts  Decision = 'new' | 'continue' | 'close' | 'reopen' | 'no_action'
// lib/council/decide.ts (pure)  export function combineVotes(a: Vote, b: Vote): FinalDecision   // documented tie-break
// lib/council/job.ts (server-only)
export async function runCouncilJob(o: { write: boolean; limit: number; clientIds?: string[] }): Promise<JobResult>
// only clients with council_enabled; skips messages that already have a council_verdicts row (idempotent)
```

### hubspot
```ts
// lib/buckets.ts  export const BUCKETS: { key: string; label: string; description: string }[]  // placeholder until leadership confirms
//                 export async function getClientBucket(clientId): Promise<string | null>
//                 export async function setClientBucket(user, clientId, bucket): Promise<void> // throws BucketStorageNotApprovedError until a column is approved
// lib/hubspot/sync.ts  export async function runHubspotSync(o: { write: boolean }): Promise<JobResult>
// HubSpot to Shadow: deal stage / amount / payment, deal won creates client. Shadow to HubSpot: va_bucket, va_accountant, va_health_score, va_open_tickets, va_open_escalations
```

### context-agent
```ts
// lib/agent/tools.ts   tools scoped by AppUser: searchMessages (full text on body_tsv, vector when embeddings exist), getTickets, getFiles, getMeetings, getClientProfile
// app/api/chat/route.ts  streaming chat (Vercel AI SDK), every claim cites { kind, id, at, link? }; says so when nothing is found
```
