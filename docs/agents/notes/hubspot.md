# hubspot notes

Status: DONE (built against fixtures only; nothing called HubSpot or Supabase).
Checks: `npm run test` 11 files / 129 tests pass (mine: 4 files, 35 tests). `npm run lint` passes.
`npm run typecheck`: no errors in my files; remaining errors are in `lib/scoring/job.ts` and `lib/council/job.ts` (see Requests).

## Built
- `lib/hubspot/client.ts`: fetch wrapper for CRM v3 Deals (search modified since, batch read, batch update; chunks of 100).
  Retries 429 and 5xx with backoff (Retry-After when sent, else 1s, 2s, 4s, 8s, cap 30s; 4 retries). Injectable fetch/sleep for tests.
- `lib/hubspot/mapping.ts` (pure): field mapping, diffing, pull planning.
- `lib/hubspot/signature.ts` (pure): HubSpot v3 webhook signature check, webhook payload to deal ids (zod).
- `lib/hubspot/sync.ts` (server-only): `runHubspotSync`.
- `lib/buckets.ts`: placeholder BUCKETS (YTRO, DC, DS, meanings to be confirmed), storage not approved.
- `app/api/jobs/hubspot-sync/route.ts`: `GET`, `assertCronAuth` first, `write: jobsWriteEnabled()`.
- `app/api/webhooks/hubspot/route.ts`: `POST`, verifies `X-HubSpot-Signature-v3` + `X-HubSpot-Request-Timestamp`
  (within 5 minutes) with `HUBSPOT_WEBHOOK_SECRET`, then syncs only the deals in the payload (write mode respected). 401 on bad signature.
- `supabase/proposals/client-bucket.sql`: `clients.bucket text` + check constraint (YTRO, DC, DS), with rollback. NOT applied.
- Tests: `lib/hubspot/{mapping,signature,client}.test.ts`, `lib/buckets.test.ts`.

## Exports (exact import paths + signatures)
```ts
// lib/buckets.ts  (no server-only: UI may import BUCKETS)
import { BUCKETS, BUCKET_STORAGE_APPROVED, BucketStorageNotApprovedError, isBucketKey, getClientBucket, setClientBucket } from '@/lib/buckets'
BUCKETS: { key: string; label: string; description: string }[]   // YTRO, DC, DS
BUCKET_STORAGE_APPROVED: false
isBucketKey(value: string): boolean
getClientBucket(clientId: string): Promise<string | null>          // always null for now
setClientBucket(user: AppUser, clientId: string, bucket: string): Promise<void>  // throws BucketStorageNotApprovedError

// lib/hubspot/sync.ts (server-only)
import { runHubspotSync, CURSOR_KEY } from '@/lib/hubspot/sync'
runHubspotSync(o: { write: boolean; dealIds?: string[]; now?: Date }): Promise<JobResult>
//  details: { pull: { since, deals, updates[], creates[], updateCount, createCount, unchanged, ignored, cursorWritten },
//             push: { deals, changes[], changeCount, missingInHubspot[] }, bucketPushed: boolean, warnings: string[] }
//  CURSOR_KEY = 'hubspot_last_sync' (settings.value = ISO time of the last successful write-mode run start)

// lib/hubspot/mapping.ts (pure)
SHADOW_OWNED_PROPERTIES, HUBSPOT_PULL_PROPERTIES, buildShadowDealProperties, diffDealProperties, sameHubspotValue,
parseWonStageIds, parseAmount, isDealWon, mapDealToClientPatch, buildClientFromDeal, planDealPull
// lib/hubspot/signature.ts (pure)
verifySignatureV3(o): { ok: true } | { ok: false; reason }, computeSignatureV3, normaliseSignedUri, dealIdsFromWebhook(body): string[] | null
// lib/hubspot/client.ts
createHubspotClient({ token, baseUrl?, fetch?, sleep?, maxRetries? }), HubspotError, type HubspotDeal, type HubspotClient
```

## Decisions
- One owner per field. HubSpot owns `clients.deal_stage` (from `dealstage`) and `clients.amount_paid` (from `amount`).
  Shadow owns deal properties `va_bucket`, `va_accountant` (`vas.va_name` via `clients.va_id`), `va_health_score`
  (`client_scores.service_score`, rounded), `va_open_tickets` (conversations `status = 'open'`), `va_open_escalations`
  (open and `tag = 'escalation'`). Pull never writes va_* fields; push never writes dealstage / amount.
- No loops: pull writes a client only when stage / amount differ from the row; push sends only properties whose value
  differs from what HubSpot already has (null equals '', "72" equals "72.0"). A second run is a no-op.
- "Paid" = deal is in a won stage (`HUBSPOT_WON_STAGE_IDS`). The portal has no separate payment property we know of,
  so `amount_paid` is copied only for won deals. Without `HUBSPOT_WON_STAGE_IDS`, amounts and new clients are skipped (warning in details).
- Deal won with no client that has that `hubspot_deal_id` creates a client: `client_name` = dealname (fallback
  `HubSpot deal <id>`), `deal_stage`, `amount_paid`, `va_id` empty so it appears in Admin assignment. A unique
  violation (23505, webhook and cron racing) is treated as "already created".
- Cursor `hubspot_last_sync` is written only in write mode, only by the scheduled run (not the webhook), and only when
  every client write succeeded. First run (no cursor) pulls all deals.
- `va_bucket` is skipped while `BUCKET_STORAGE_APPROVED` is false. When the proposal is approved: add the column,
  implement get/setClientBucket, flip the flag; the sync then pushes it.
- Webhook signs `req.method + req.url + body + timestamp`; HubSpot decoded characters (`%3A`, `%2F`, ...) handled.
  Non-deal events are ignored; ids must be numeric.

## Requests
- integrator: add to `.env.example` and Vercel: `HUBSPOT_WON_STAGE_IDS` (comma list of closed-won deal stage ids,
  read via `process.env` in `lib/hubspot/sync.ts`). `HUBSPOT_ACCESS_TOKEN` and `HUBSPOT_WEBHOOK_SECRET` already exist.
- integrator: `vercel.json` cron for `GET /api/jobs/hubspot-sync` (suggest every 15 minutes, `*/15 * * * *`).
- integrator / engineer (live setup, needs approval): HubSpot private app scopes `crm.objects.deals.read` and
  `crm.objects.deals.write`; create the five custom Deal properties (`va_bucket` text, `va_accountant` text,
  `va_health_score` number, `va_open_tickets` number, `va_open_escalations` number). Webhook subscriptions:
  `deal.creation` and `deal.propertyChange` for `dealstage` and `amount` only (not va_*), target
  `https://<host>/api/webhooks/hubspot`; the app's client secret is `HUBSPOT_WEBHOOK_SECRET`.
- admin-engineer-ui: "HubSpot sync status" can read settings key `hubspot_last_sync` (exported as `CURSOR_KEY`).
  Ask data for a getter if you need it in `lib/data`.
- accountant-ui: bucket switch should catch `BucketStorageNotApprovedError` and show it as disabled ("Bucket changes
  are not live yet").
- scoring: typecheck fails in `lib/scoring/job.ts` (cannot find `@/lib/metrics/load`, implicit any at line 88).
- council: typecheck fails in `lib/council/job.ts:209` (`ContextConversation[]` not assignable to `StoredConversation[]`).

## Known gaps
- Not run against HubSpot or Supabase. First live run should be dry-run and the `details` reviewed.
- Existing `clients.deal_stage` values may be stage labels rather than HubSpot stage ids; the first write run would
  overwrite them with ids. Check the dry-run `pull.updates` first.
- HubSpot search is capped at 10,000 results per query; fine for this portal size.
- Behind a proxy that rewrites the host, `req.url` may not match the URL HubSpot signed; Vercel is fine.
- Bucket proposal list (YTRO, DC, DS) awaits leadership confirmation.
