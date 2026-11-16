# accountant-ui notes

Status: DONE (code and tests). Nothing run against live systems. At the end of this build, from the repo root:
`npm run typecheck` clean, `npm run lint` clean, `npm run test` 25 files / 283 tests pass (mine: 2 files, 19 tests).
`next build` not run by accountant-ui (shared `.next`, other agents still building).

## Built
- `app/(app)/home/page.tsx`: KPI cards (my clients, open tickets, SLA breached, average health, unanswered), my open
  tickets sorted by SLA lag with tag badges and actions, clients by bucket (all under "Bucket not set" with a note),
  "Today" feed (`listRecentActivity`, 24 h, 40 items), "Ask AI" primary button to `/ask`.
- `app/(app)/clients/page.tsx`: GET search form (`?q=`, passed to `listClients` search), list with health + delta, open
  tickets (+ escalations), last message, "Waiting for reply". Accountant name shown for admin / engineer.
- `app/(app)/clients/[id]/page.tsx` (Client 360): `notFound()` when `getClient` returns null (out of scope or missing),
  custom `not-found.tsx`. Health (service / mood, deltas, top reasons, inline SVG trend from `getScoreHistory(30)`),
  open and closed tickets with actions, "Files received" monthly grid (AR / AP / Bank / Other, 6 months, IST), timeline
  (messages with "From client" / "From team", files, meetings, tickets), profile, bucket (read only, disabled switch),
  contacts, meetings, "Ask AI about this client" primary button to `/ask?client=<id>`.
- `app/(app)/tickets/page.tsx`: GET filters status (open default / closed / all), tag, free-text search; open tickets
  sorted most urgent first.
- `app/(app)/tickets/actions.ts` ('use server'): `ticketAction` for close / reopen / change tag.
- `loading.tsx` for every route, `error.tsx` for home / clients / tickets (clients/[id] uses the clients boundary).
- `components/accountant/*`: `logic.ts` (pure), `ticket-intent.ts` (pure), `ui.tsx`, `ticket-list.tsx`,
  `ticket-actions.tsx` (client), `activity-feed.tsx`, `files-grid.tsx`, `bucket-control.tsx`, `page-skeleton.tsx`,
  `page-error.tsx` (client). Tests: `logic.test.ts`, `ticket-intent.test.ts`.

## Exports (exact import paths + signatures)
```ts
// app/(app)/tickets/actions.ts ('use server')
import { ticketAction } from '@/app/(app)/tickets/actions'
ticketAction(prev: TicketActionState, formData: FormData): Promise<TicketActionState>
// form fields: id, intent = 'close' | 'reopen' | 'tag', tag (when intent = 'tag'; one of council TAGS)

// components/accountant/ticket-intent.ts (pure, client-safe)
type TicketActionState = { ok: boolean; message: string | null }
parseTicketIntent(form: FormData): TicketIntent;  isTag(v: unknown): v is Tag;  TAG_LABELS: Record<Tag, string>

// components/accountant/logic.ts (pure, client-safe)
computeHomeKpis(clients: ClientListItem[], openTickets: ConversationItem[]): HomeKpis
groupClientsByBucket(clients, buckets: Map<string, string | null>): BucketGroup[]   // NO_BUCKET_LABEL last
ticketWaitMinutes(t: ConversationItem, now: Date): number | null
sortTicketsBySlaLag(tickets, now): ConversationItem[]     // breached, then longest client wait, then oldest activity
filterTickets(tickets, q?): ConversationItem[]
categoriseDocument(d: { folderName; fileName }): 'AR' | 'AP' | 'Bank' | 'Other'
buildFilesGrid(docs, now, monthsBack = 6, timezone = 'Asia/Kolkata'): FilesGrid
healthTone(score): 'good' | 'watch' | 'risk' | 'none'    // >= 75, >= 50, < 50
sparklinePoints(values, width, height, min = 0, max = 100): string
canEditTickets(user): boolean                             // senior_accountant / admin, never while viewing as
safeHref(url): string | null                              // http(s) only
formatDelta, formatMinutes, formatDateTime, formatDate, formatAgo, monthKey

// components/accountant/ui.tsx: PageHeader, Section, KpiCard, EmptyState, TagBadge, SlaBadge, StatusBadge,
//   HealthValue, DirectionLabel, ScoreTrend.  Others: TicketList, ActivityFeed, FilesGrid, BucketControl, PageSkeleton, PageError
```
admin-engineer-ui may reuse `TicketList`, `TagBadge`, `HealthValue`, `ActivityFeed` if useful (read only for engineers
is handled by `canEditTickets`).

## Decisions
- All data through `@/lib/data` in server components; the only mutation is `ticketAction` calling `updateConversation`
  after `requireUser()` and `assertNotViewingAs(user)`. `ForbiddenError` / `ViewAsReadOnlyError` messages are shown as
  is; `Ticket not found.` shown as is; zod errors become "That change is not valid."; anything else is logged and shown
  as "Could not update the ticket. Please try again." Revalidates `/home`, `/tickets`, `/clients/[id]`.
- Ticket controls are hidden (with a short note) for engineers and while viewing as, matching the data layer rules.
- SLA lag: wait is shown only for open tickets whose `lastMessageDirection` is `incoming` (council stores the effective
  direction). Wall clock minutes.
- Average health = mean `serviceScore` of scored clients. Unanswered = clients with `unansweredCount > 0`.
- Buckets: `getClientBucket` is called per client (always null today), so the grouping works once storage is approved.
  Bucket switch on Client 360 is a disabled `role="switch"` with the text "Bucket changes are not live yet. Storing
  buckets needs approval first". No call to `setClientBucket` (nothing to catch until storage exists).
- Files received: category is a keyword guess on folder + file name (bank / statement, then purchase / bill / expense /
  vendor, then sales / invoice / receivable); labelled as a best guess. Files without `uploadedAt` are skipped.
- Links from stored data (meeting Teams URL, timeline links) render only when `http(s)` (`safeHref`).
- Message bodies are rendered as plain text (React escaping), never as HTML.
- One accent button per screen: Home "Ask AI", Clients "Search", Tickets "Apply", Client 360 "Ask AI about this
  client". Ticket actions are outline / ghost.
- Filters and search use plain GET forms (no client JS); search text capped at 100 characters.
- Dates shown in IST (`Asia/Kolkata`) with `en-IN` formatting.

## Requests
- context-agent: Client 360 links to `/ask?client=<clientId>` and Home links to `/ask`, as in your notes.
- data (optional, not blocking): a `lastMessageDirection` for the client list (to show "Last message from client")
  and a per-client "last file received" date would make the Clients list richer.
- integrator: no new env vars. Please run `next build` once all agents finish; accountant-ui has not run it.
- hubspot / leadership: when `clients.bucket` is approved and `getClientBucket` / `BUCKET_STORAGE_APPROVED` are live,
  Client 360 needs a real bucket picker calling a new server action around `setClientBucket` (not built).

## Known gaps
- Not verified in a browser or against live data (no live calls allowed); layouts checked by reading only.
- `getClientBucket` per client is fine while it returns null; once it hits the DB, a bulk getter would be better.
- Ticket summary / title editing is not exposed (only close, reopen, tag), as scoped.
- Timeline shows the latest 100 items with no "load more"; closed tickets on Client 360 show the latest 10.
- Files received only knows `document_uploads` (WhatsApp files); Drive files appear only once logged there. No
  SharePoint links (`DocumentItem.url` is always null).
- No component tests for rendering (node-only Vitest, no jsdom); logic is covered by pure tests.
