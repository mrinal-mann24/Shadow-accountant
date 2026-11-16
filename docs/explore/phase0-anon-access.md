# Phase 0 Explore: anon access on Supabase VA

Date: 16 Nov 2026. Read-only investigation. Nothing was changed.

## Scope
- **Goal:** close public (anon key) access to client data in Supabase VA without breaking whatever uses it today.
- **Constraints:** no new tables or views, no production changes without approval, extend existing code rather than rebuild.
- **Success criteria:** anon can read or write no client data; every current anon caller is found and moved first; nothing that runs today breaks.

## 1. Which project
Supabase VA is project `kxlrxqewcnwcstzvyrcr`. It is reachable only through the project-scoped Supabase
connector; it does not appear in the "AI Accountant" org project list. The tables match `docs/CONTEXT.md`.

## 2. What anon can do today

Supabase's default privileges give `anon` and `authenticated` **every privilege** (SELECT, INSERT, UPDATE,
DELETE, TRUNCATE) on every table, view, function and sequence created in `public`. RLS is the only thing
holding them back. Current state per table:

| Exposure | Tables | Effect for anyone holding the anon key |
|---|---|---|
| **RLS off** (advisor: ERROR) | `client_contacts` (206 rows), `addition_charges` (3) | Full read, insert, update, delete |
| **anon ALL policy** `using (true)` | `vas` | Full read and write of accountant records (email, WhatsApp number, Teams chat id) |
| **anon SELECT policy** `using (true)` | `clients` (incl. GSTIN, PAN), `client_messages`, `conversations`, `council_verdicts`, `client_scores`, `client_score_history` | Full read |
| RLS on, no policy | `client_pricing`, `document_uploads`, `flagged_messages`, `invoices`, `message_processing_log`, `release_note_sends`, `renewal_jobs`, `score_weights`, `settings`, `va_meeting_transcripts` | Blocked for anon and authenticated (service role only) |
| Views (`security_invoker=on`) | `clients_meeting_picker`, `conversation_response_lags` | Follow the RLS of the underlying tables |

Why `vas` matters more than the others: the new app maps login email to `vas.email`. If anon can
rewrite `vas`, anyone could later grant themselves an accountant's client list.

### Functions exposed to anon
- `kb_encrypt_secret`, `kb_decrypt_secret` and `kb_upsert_credential` can be called by anon over RPC.
  `kb_upsert_credential` writes client passwords into `public.client_credentials`, **which no longer exists**,
  so it is broken today. This is a client-password store, against our standing rule.
- 4 functions have a mutable `search_path` (advisor: WARN): the 3 above and `increment_va_client_count`
  (the trigger on `clients` insert).
- `vector` extension sits in `public` (advisor: WARN). Low risk; moving it is disruptive, so leave it.

## 3. Who uses the anon key

Supabase API logs could not be read (the logs endpoint did not respond). I used Postgres query
statistics instead. They have been cumulative since 15 Jun 2026 and carry **no timestamps**, so they
show what has called, not whether it still calls.

| Role | Calls since 15 Jun |
|---|---|
| `service_role` | about 1.72 million |
| `anon` | 1,486 |
| `authenticated` | 0 (no app uses Supabase Auth yet) |

Most of the system (council, ingestion, n8n) already runs on the service role. Anon is a small surface.
The anon callers fall into 5 patterns:

| # | Pattern (from the queries) | Calls | Likely caller | Status |
|---|---|---|---|---|
| A | `clients_meeting_picker` (client name + email), sorted by name | 139 | Meeting transcript client picker | Unconfirmed |
| B | Dashboard reads: `client_scores` by service score, `client_score_history`, `conversations` by client, `council_verdicts` with GPT and Claude reasoning, `client_messages` timestamps and direction | about 180 | A health / council dashboard. Best guess: the Taipy "AIA Ops Dashboard" on the VPS (`ops.aiaccountant.com`, `/opt/taipy-dashboard`) | Unconfirmed, code not seen |
| C | Writes: INSERT into `clients` and `client_contacts`, UPDATE `clients.assigned_va` and `client_name` | 19 | An onboarding / admin form | Writes to `clients` now fail (only a SELECT policy exists); `client_contacts` writes still succeed (RLS off) |
| D | Reads and writes on `hubspot_campaign_deals`, `google_ads_campaigns`, `google_ads_daily_metrics` | about 230 | A marketing dashboard / sync | These tables no longer exist here, so this caller is already broken or was moved |
| E | `select va_id, va_name, status from vas` | 1 | Ad-hoc test | Ignore |

### n8n
- 5 Supabase credentials exist. One is named **"VA Supabase"** (id `4r6qxhgfx1zSEz4n`). n8n hides the key,
  so it is not yet known whether it holds the anon key or the service key.
- 2 workflows checked (Ops Daily Snapshot, Renewal Alert for Finance): neither calls Supabase VA. The
  snapshot workflow SSHes into the Taipy VPS; the renewal alert uses a different Postgres database.
- 320 other workflows were not opened.

## 4. Not checked yet (the gaps)
1. Supabase API logs filtered to role `anon` (gives the user agent and IP for each caller). Needs the logs
   endpoint to respond, or a look in the Supabase dashboard.
2. The Taipy dashboard code on the VPS (which key it uses).
3. va-bot code on the engineer's machine.
4. Which key the n8n "VA Supabase" credential holds, and which workflows use it.
5. Any other frontend (Vercel, Retool, Lovable, etc.) holding the anon key.

## 5. Risks for the fix
- Revoking anon SELECT breaks callers A and B until they move to the service role on a server, or to
  logged-in users.
- Turning RLS on for `client_contacts` breaks caller C's contact inserts.
- Policies alone are not enough: the default grants mean every **new** table is also fully open to anon
  until someone remembers RLS. The fix should also revoke the grants and change the default privileges.
- TRUNCATE ignores RLS. PostgREST does not expose it, but the grant should still go.
- `pg_stat_statements` cannot prove a caller has stopped. Before cutting off, either read the API logs
  or take two snapshots a day or two apart and compare the call counts.

## 6. Snapshot for comparison (anon calls, 16 Nov 2026)
`clients_meeting_picker` 139, `clients` (id, name) 56, `client_scores` 36, `client_score_history` 32,
`conversations` by client 22, `conversations` all 19, `council_verdicts` 19 + 11 + 11,
`clients` UPDATE `assigned_va` 10, `client_contacts` INSERT 3, `clients` INSERT 3 + 1.
If these numbers have not moved when we look again, the caller is dormant.
