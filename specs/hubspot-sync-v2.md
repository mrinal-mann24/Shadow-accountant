# HubSpot sync v2: VA client rule

Status: plan, waiting for approval. Written 16 Nov 2026 from a read-only look at HubSpot and Supabase VA.

## Goal

Shadow Accountant treats a deal as a VA client using the same rule as the HubSpot view
"Finance Collections View-VA", keeps stage, payment and active/inactive state in step with HubSpot,
and stops writing things HubSpot cannot accept.

## The rule (from the HubSpot view)

A deal is an **active VA client** when all three hold:

1. `pipeline` = `1534965463` (Virtual Accounting)
2. `hs_v2_date_entered_2462646003` is set (it has entered Payment Done at least once)
3. `dealstage` is one of `2462646003` Payment Done, `3668025064` Ready for Renewal, `3102360263` Renewal Done

Other VA pipeline stages that matter for clients we already have:
`3128528610` Churned, `4080072411` AM Parked, `3668025063` Onboarded (not in the view today).

Live check on 16 Nov 2026: this rule returns exactly the 28 deals in the view.

## What we found

| Finding         | Detail                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active deals    | 28. 27 are in `clients` (matched on `hubspot_deal_id`). 1 is missing: wishtrailz (`353849235153`).                                                                                                                         |
| Test data       | "Tester Mrinal coder" (`337128679127`) is in the view and in `clients`; "MRINAL" is a client row with no deal.                                                                                                             |
| Stale clients   | 37 clients link to VA deals that HubSpot now has as **Churned (28)** or **AM Parked (9)**. Our DB still says "Payment Done" for most. 27 of them are assigned to Shruti Nair (6 Harshit, 3 Puneeth, 1 Ajith).              |
| Stage storage   | `clients.deal_stage` holds labels ("Payment Done"). The current sync would write HubSpot stage ids over them.                                                                                                              |
| Amount          | HubSpot `amount` is the contract value; `amount_paid` is what was paid (e.g. Forelife 80,000 vs 40,000). The current sync copies `amount`.                                                                                 |
| Accountant      | HubSpot `am_deal_owner` (owner id) is empty on 7 of 28 active deals and disagrees with `clients.va_id` on several (e.g. Varsha Forgings, Dioste: HubSpot says Harshit, DB says Shruti). Shruti Nair is not a HubSpot user. |
| Push properties | `va_bucket`, `va_accountant`, `va_health_score`, `va_open_tickets`, `va_open_escalations` do not exist on HubSpot deals, so the current push would fail.                                                                   |
| Client status   | `clients.status` already holds "Active" (74) / "Inactive" (15).                                                                                                                                                            |

## Field ownership (proposed, matches the 16 Nov meeting: Shadow is the source of truth)

| Field                                               | Owner                      | Notes                                                             |
| --------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| Deal exists, stage, amount paid, first payment date | HubSpot                    | Sales and finance work there                                      |
| `clients.status` Active / Inactive                  | Derived from HubSpot stage | Active = rule above; Churned / AM Parked = Inactive               |
| Accountant (`va_id`)                                | **Shadow**                 | HubSpot `am_deal_owner` only pre-fills a **new** client           |
| Bucket, health, tickets                             | Shadow                     | Not pushed to HubSpot until properties exist and push is approved |

## Sync design

- **Trigger:** cron every 30 min (existing) and the HubSpot webhook (existing, same logic).
- **Input:** HubSpot deal search `pipeline = 1534965463 AND hs_v2_date_entered_2462646003 HAS_PROPERTY` (every
  paid VA deal, 66 on 16 Nov, one page; changed in build from a modified-since cursor, see Cursor below), properties
  `dealname, dealstage, pipeline, amount_paid, am_deal_owner, hs_v2_date_entered_2462646003, va_1st_payment_date`.
  Stage labels from `GET /crm/v3/pipelines/deals/1534965463` once per run. Owner emails from the owners API
  (only to pre-fill a new client's accountant by matching `vas.email`).
- **Output (only when `hubspot-sync` is in `JOBS_WRITE_ONLY`):**
  - existing client: `deal_stage` = stage label, `amount_paid` = HubSpot `amount_paid`, `status` = Active / Inactive
  - active deal with no client: insert `clients` row (name from deal name without "<> VA" / "\_VA" suffix,
    `hubspot_deal_id`, stage label, `amount_paid`, `onboarding_date` = `va_1st_payment_date` or date entered
    Payment Done, `status` Active, `va_id` from `am_deal_owner` when it maps to a `vas` email, else null)
  - push to HubSpot: **off** (`HUBSPOT_PUSH_ENABLED`, default false)
- **Idempotency:** match on `hubspot_deal_id` (unique). Patches only send changed fields. Re-running gives no change.
- **Duplicates:** before inserting, look for an existing client with a similar name and no deal id; if found, do not
  insert, report it in `details.needsReview`. Cap of 10 creates per run stays.
- **Ignore list:** `HUBSPOT_IGNORE_DEAL_IDS` (test deals such as `337128679127`).
- **Cursor (changed in build):** none. Every run reconciles all paid VA deals, so a missed webhook heals on the next
  run and there is no first-run special case. `settings.hubspot_last_sync` now only records the last scheduled write
  run with no failed writes (shown on Admin and Engineer). Creates stay behind the cap and the similar-name check.
- **Retries / rate limits:** existing client (429 backoff, batch reads of 100). One pipeline call and one owners call per run.
- **Secrets:** `HUBSPOT_ACCESS_TOKEN` (private app, scopes: deals read, schemas read, owners read; write only if push is approved later).
- **Never:** change `client_messages`, delete clients, touch HubSpot when push is off.

## Env changes

Remove `HUBSPOT_WON_STAGE_IDS`. Add `HUBSPOT_VA_PIPELINE_ID=1534965463`, `HUBSPOT_VA_PAID_STAGE_ID=2462646003`,
`HUBSPOT_VA_ACTIVE_STAGE_IDS=2462646003,3668025064,3102360263`, `HUBSPOT_IGNORE_DEAL_IDS`, `HUBSPOT_PUSH_ENABLED=false`.

## App changes

- Client lists, Home, Team and the health score / council jobs use **active clients only** by default; Clients page
  gets an "Inactive" filter so history stays visible.

## Steps (each verified before the next)

| #   | Step                                                                                           | Files                                                                                       | Verify                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Pure classifier: deal to active / inactive / ignore, stage label, client patch, new client row | `lib/hubspot/mapping.ts` (+ tests from the 65 real deals above, names only)                 | unit tests                                                                                              |
| 2   | Pull with pipeline filter, labels, owners; push behind flag                                    | `lib/hubspot/client.ts`, `lib/hubspot/sync.ts`, webhook route (+ tests)                     | unit tests                                                                                              |
| 3   | Env and docs                                                                                   | `.env.example`, `README.md`, `CLAUDE.md` (HubSpot ownership line)                           | review                                                                                                  |
| 4   | Active-only lists and jobs, Inactive filter                                                    | `lib/data/clients.ts`, `lib/scoring/job.ts`, `lib/council/store.ts`, clients page (+ tests) | unit tests, browser                                                                                     |
| 5   | Dry run against live HubSpot                                                                   | needs `HUBSPOT_ACCESS_TOKEN` in `.env.local`                                                | expect: 27 updated, 37 set Inactive (28 churned, 9 parked), 1 would-create (wishtrailz), tester ignored |

## Decisions needed

1. Churned and AM Parked clients: mark Inactive and hide by default (recommended), or keep showing them?
2. Accountant: Shadow owns `va_id` and HubSpot only pre-fills new clients (recommended)?
3. Push to HubSpot: keep off until the properties exist (recommended), or create the 5 properties in HubSpot now?
4. Is "Onboarded" an active stage? The HubSpot view leaves it out.
