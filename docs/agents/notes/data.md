# data notes

Status: DONE. `npm run typecheck`, `npm run test` (whole repo) and `npm run lint` pass. Nothing was run against
Supabase; all data functions are tested against an in-memory fake client.

## Built
- `lib/team/phone.ts` (pure, client-safe), `lib/team/index.ts` (server-only, re-exports phone.ts + `getTeamNumbers`).
- `lib/metrics/index.ts` (pure metrics), `lib/metrics/business-time.ts` (business-hours maths), `lib/metrics/load.ts`.
- `lib/data/*`: `index.ts` (barrel, server-only), `types.ts`, `scope.ts`, `paginate.ts`, `clients.ts`, `messages.ts`,
  `conversations.ts`, `scores.ts`, `documents.ts`, `timeline.ts`, `admin.ts`, `testing/fake-supabase.ts` (tests only).
- Tests: `lib/team/phone.test.ts`, `lib/metrics/index.test.ts`, `lib/data/data.test.ts` (scope, roles, view as,
  mutations, pagination, timeline).

## Exports (exact import paths + signatures)
```ts
// lib/team (server-only). Pure helpers also at '@/lib/team/phone' for client code.
import { normalizePhone, parseTeamNumbers, effectiveDirection, getTeamNumbers, clearTeamNumbersCache,
  TEAM_NUMBERS_SETTING_KEY, type Direction } from '@/lib/team'
normalizePhone(raw: string | null): string | null            // digits only, last 10; null if < 10 digits
parseTeamNumbers(vaNumbers: (string | null)[], settingValue: string | null): Set<string>
effectiveDirection(m: { sender_phone: string | null; direction: string | null }, team: Set<string>): 'incoming' | 'outgoing'
getTeamNumbers(): Promise<Set<string>>   // vas.whatsapp_number + settings 'team_whatsapp_numbers'; memoised 60 s

// lib/metrics (pure)
import { computeClientMetrics, businessMinutesBetween, median, isThanks, THANKS_PATTERN,
  type MetricMessage, type ClientMetrics } from '@/lib/metrics'
computeClientMetrics(msgs: MetricMessage[], opts: { now: Date; timezone: string }): ClientMetrics
businessMinutesBetween(a: Date, b: Date, timezone: string): number   // Mon to Sat 10:00 to 19:00 local, fractional

// lib/metrics/load.ts (server-only, NOT user-scoped: jobs only)
import { loadClientMessagesForMetrics } from '@/lib/metrics/load'
loadClientMessagesForMetrics(clientId: string, windowDays: number): Promise<MetricMessage[]>   // oldest first

// lib/data (server-only). Item types: import type { ... } from '@/lib/data/types' (or '@/lib/data')
import { listClients, getClient, listMessages, listConversations, updateConversation, getClientScores,
  getScoreHistory, listDocuments, listMeetings, getTimeline, listRecentActivity, listVas, assignClient,
  getTeamOverview, getSystemHealth, setCouncilEnabled, retryProcessing,
  scopeOf, canAccessClient, scopedClientIds, ForbiddenError, ViewAsReadOnlyError } from '@/lib/data'
listClients(user, f?: { search?: string; vaId?: string }): Promise<ClientListItem[]>        // sorted by name
getClient(user, clientId): Promise<ClientDetail | null>                                  // + contacts, vaName, topReasons
listMessages(user, clientId, o?: { before?: string; limit?: number }): Promise<MessageItem[]>
  // newest `limit` (default 50, max 200) before `before`, returned OLDEST FIRST; next page: before = items[0].at
listConversations(user, f?: { clientId?: string; status?: 'open' | 'closed'; tag?: string }): Promise<ConversationItem[]>
updateConversation(user, id, patch: { status?; tag?; summary?; title? }): Promise<void>
getClientScores(user, clientIds?: string[]): Promise<ScoreItem[]>
getScoreHistory(user, clientId, days): Promise<ScoreHistoryItem[]>                       // oldest first
listDocuments(user, clientId): Promise<DocumentItem[]>     // document_uploads, newest first, url always null
listMeetings(user, clientId): Promise<MeetingItem[]>       // va_meeting_transcripts, newest first
getTimeline(user, clientId, o?: { limit?: number }): Promise<TimelineItem[]>             // default 100, max 500
listRecentActivity(user, o?: { sinceHours?: number; limit?: number }): Promise<ActivityItem[]>  // default 24 h / 50
listVas(user): Promise<VaItem[]>
assignClient(user, clientId, vaId: string | null): Promise<void>
getTeamOverview(user): Promise<TeamOverview>
getSystemHealth(user): Promise<SystemHealth>
setCouncilEnabled(user, clientId, enabled): Promise<void>
retryProcessing(user, messageId): Promise<void>
```
Types in `lib/data/types.ts`: `ClientListItem, ClientDetail, ContactItem, MessageItem, ConversationItem,
ConversationPatch, ConversationStatus, ScoreItem, ScoreHistoryItem, DocumentItem, MeetingItem, TimelineItem,
TimelineKind, ActivityItem, VaItem, AccountantWorkload, TeamOverview, ProcessingFailure, SystemHealth, Direction`.
All timestamps are ISO strings, so items can be passed to client components.

### Who may call what
| Function | senior_accountant | admin | engineer | view as |
|---|---|---|---|---|
| reads (clients, messages, tickets, scores, docs, meetings, timeline, activity) | own clients | all | all | viewed accountant's clients |
| listVas | `[]` | yes | yes | `[]` |
| getTeamOverview | throws ForbiddenError | yes | yes | throws |
| getSystemHealth | throws | throws | yes | throws |
| updateConversation | own clients | any | throws | throws ViewAsReadOnlyError |
| assignClient | throws | yes | throws | throws ViewAsReadOnlyError |
| setCouncilEnabled, retryProcessing | throws | throws | yes | throws ViewAsReadOnlyError |

Reads return `null` / `[]` when out of scope. Mutations throw `ForbiddenError` (or `ViewAsReadOnlyError`, a
subclass) from `@/lib/auth/roles`, `ZodError` for an invalid patch, and `Error('Ticket not found.' |
'Client not found.' | 'Accountant not found.' | 'Processing record not found.')`.

## Decisions
- Scope is always `clients.va_id` (never `conversations.va_id` or `client_scores.va_id`). A senior accountant with
  `vaId = null` sees nothing. `viewingAs` wins over role. Uses `canSeeAllClients` / `assertNotViewingAs` from auth.
- Effective direction: outgoing when the sender's last 10 digits are a team number, or when stored as outgoing;
  everything else (including null) is incoming.
- `getTeamNumbers` uses a 60 s module memo instead of React `cache()` (which does not memoise in route handlers,
  where jobs run). scoring: this answers your request; 88 calls per job now cost one DB round trip.
- Metrics definitions (also at the top of `lib/metrics/index.ts`):
  - Lag measured from the first message of the incoming run to the first outgoing message after it.
  - `unansweredCount` is 0 or 1 (only the last run can be unanswered).
  - `answeredWithin7dPct` leaves out runs younger than 7 days with no reply yet; an unanswered run older than
    7 days counts as not answered.
  - Proactive is judged against the LATEST incoming message before the outgoing run (a reply to a message sent
    yesterday is reactive even if the run started 8 days ago). Lag for "within 7 days" uses the first message.
  - `worstLagMin`, `lagsOver4h`, `lagsOver24h` are wall-clock and include the current wait of an unanswered run.
  - Thanks regex `/\b(?:thanks?|thx|tysm|dhanyavad)\b/i`, counted per incoming message.
  - Percentages 0 to 100; minutes and percentages rounded to 1 decimal. Messages after `now` are ignored.
- Business hours handle any IANA timezone (DST-safe) via `Intl`; no date library.
- Ticket updates: allowed roles senior_accountant (own clients) and admin; engineer is read-only on tickets.
  Closing sets `closed_at = now`, reopening clears it, `updated_at` always set. Patch is zod-validated and strict.
- `assignClient` changes only `clients.va_id` (`null` unassigns). Open tickets keep their old `conversations.va_id`
  and `client_scores.va_id` refreshes on the next score run; scope does not depend on either.
- `retryProcessing` sets `message_processing_log.status = 'pending'` only (attempts and error kept as history,
  `client_messages.processed_at` untouched). council: per your notes this is enough for a retry.
- `listDocuments` builds no URL (`url: null`): `document_uploads` has no link column. `path` = folder / file name.
- `getSystemHealth` also returns `hubspotLastSync` (raw settings value `hubspot_last_sync`) for admin-engineer-ui.
- Client search is done in memory (about 90 clients) on name, legal name and group name: no PostgREST filter
  strings built from user input.
- Every list read goes through `fetchAll` (1000-row pages, stable order with a unique last key); `.in()` lists are
  chunked at 150 ids. Malformed ids (Postgres 22P02) are treated as not found.
- `ClientDetail` leaves out PAN (government id) on purpose; GSTIN is included.

## Requests
- accountant-ui / admin-engineer-ui / context-agent: import from `@/lib/data` in server code only. Use
  `MessageItem.direction` (effective), never `storedDirection`. Catch `ForbiddenError` from mutations and show
  "You do not have access to do this." (the error message is already Indian English).
- integrator: no new env vars. Team numbers need the settings row `team_whatsapp_numbers` (comma separated, about 22
  numbers, open question 2 in CONTEXT.md) inserted by a human with approval; until then only `vas.whatsapp_number`
  counts and most team replies stay "incoming".
- scoring: noted your gap that a run starting before the window is not seen; `loadClientMessagesForMetrics` keeps
  its contract signature. If you want, call it with `windowDays + 7` and filter.

## Known gaps
- Public holidays are not handled in business hours (counted as business days).
- `unansweredCount` counts a trailing "thanks" or "ok" from the client as unanswered (no "needs reply" detection).
- "thankyou" / "thanku" written as one word are not counted as thanks (spec says whole words only).
- `listMessages` paging by `before` can skip messages that share the exact same timestamp across a page boundary.
- `listMeetings` selects the transcript text to compute `hasTranscript` (7 rows today; revisit when it grows).
- `conversation_response_lags` view is not used (it relies on the stored direction).
- `message_processing_log` status values `pending` / `failed` are assumed from the council notes.
- Not verified against live data: row counts, pagination over 14.7k messages and the effective-direction split
  should be checked dry-run on a sample with an accountant (ROADMAP stage 3).
