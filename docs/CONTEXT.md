# Shadow Accounting: full project context

Read this first. It captures every decision, what is already live, what exists in the database,
and what to build next. Specs in `/specs` are the source of truth for *how* to build; this file
explains *why* and *what already exists*. Last updated: 10 Nov 2026.

## Summary of decisions

| # | Decision | Why |
|---|---|---|
| 1 | Build our own ops tool, **Shadow Accounting** | No tool covers WhatsApp client groups + files + meetings + Tally / GST for an Indian VA practice, and most of the base already exists in Supabase |
| 2 | **HubSpot stays** as the Growth team's CRM (inbound and outbound) | Sales keeps its tool. Shadow Accounting syncs with it both ways |
| 3 | Accountants use **only Shadow Accounting** | No manual HubSpot updates, no separate ticket tool. Bucket changes (e.g. YTRO, DC, DS) are made in Shadow Accounting and reflect in HubSpot |
| 4 | Ticketing lives in Shadow Accounting (Supabase `conversations`), created by the AI "council" from WhatsApp | Already built and running for one client. Jira dropped |
| 5 | 3 roles: Senior Accountant, Admin, Engineer | Least access. Accountants see only their own clients |
| 6 | Supabase "Supabase VA" is the single brain | All sources write there. Agents and UI read from there |
| 7 | **No new tables or views without approval** | Keep schema lean (standing rule) |
| 8 | n8n stays the collection layer | Drive and WhatsApp collection are live on it |
| 9 | Collection is deterministic (fixed flows); AI sits on top | Accounting cannot miss files; agents still need triggers; cheaper, auditable, safer against prompt injection |
| 10 | Meetings via **Granola** (desktop + mobile, incl. Teams) pushed to the backend and mapped to the client | Bot-free, works across apps |
| 11 | Phone calls later via Airtel IQ recordings | Android blocks third-party call recording |
| 12 | Stack: Next.js + TypeScript on Vercel, Supabase, Vercel AI SDK + OpenRouter (Claude), Tailwind + shadcn/ui | Agreed with leadership; matches existing tooling |
| 13 | Spec-driven development with Claude Code | Specs in `/specs`, tasks in `specs/07-tasks.md` |

---

## 1. What Shadow Accounting is

AI Accountant runs **Virtual Accounting (VA)**: a CA-led managed accounting service for Indian SMBs
(about 88 clients). Client data arrives through WhatsApp groups, Google Drive, email, client portals
and calls. Today the team tracks status manually ("received / pending / needs follow-up").

Shadow Accounting is one platform where:
- every client's data, messages, files, meetings and tickets sit on one timeline (**Client 360**),
- AI opens / continues / closes tickets from WhatsApp automatically,
- accountants update buckets and work tickets in one place (HubSpot updates itself),
- leadership sees service quality, workload and risk without asking anyone,
- anyone can ask the AI about a client and get an answer **with citations**.

Goals set by leadership:
1. **Automation**: remove boring manual work (downloading, tagging, chasing, updating CRM)
2. **Visibility**: what everyone is doing and where time goes
3. **Capacity**: how many more clients the same team can handle
4. **Context**: full client history on demand (escalations, leave cover); humans apply judgement

Mental model (from leadership): **SIPOC**, i.e. Supplier (client) → Input → Process → Output → Customer (client),
with agents between each step and an intelligence layer on top.

## 2. Architecture

```
SOURCES                     COLLECTION (n8n, fixed flows)       STORE                    INTELLIGENCE              UI
WhatsApp groups (Periskope) ─┐                                  Supabase VA              Ticket agent (council)    Shadow Accounting
Google Drive (finance@)  ────┼→ detect new data ─→ save file ──→ (single brain) ───────→ Context agent (chat)  ──→ (Next.js, 3 roles)
Email accounts@ (pending) ───┤   to SharePoint, log row         + SharePoint files       Analytics / health        ↕ two-way sync
Granola meetings ────────────┤                                                           Communication agent       HubSpot (Growth CRM)
Airtel calls (later) ────────┘                                                           (later, approval first)
```

Agent roles (leadership's framing): collection / data agent, storage agent, intelligence agent,
communication agent. Inputs are classified as query, question, execution or routine task.

## 3. What is live today

### WhatsApp (live)
- Periskope webhooks → Supabase `client_messages` (14,329 messages, 62 clients, Jan to Nov 2026).
- Files from groups saved to SharePoint by "va-bot" (code on the engineer's machine; check if it runs locally, since laptop sleep stops it) and logged in `document_uploads` (6,898 rows).

### Google Drive → SharePoint (live, n8n)
- Workflow: **"VA - Drive Collection (Drive to SharePoint)"**, id `yshF9ho9UInnw5fx`, on `https://n8n.aiaccountant.com`, active, `MODE = 'live'`, runs **every 1 hour**.
- Account: clients share folders with **finance@karbonbusiness.com**. n8n credential: `Drive - finance@karbonbusiness.com` (id `JbCZ0bJ4FgIRvWv7`, Google OAuth via Google Cloud project "VA Drive Collection").
- Logic (no folder-by-folder scanning):
  1. `Build Query`: window = since last successful run (15 min overlap); first live run = last 24 h.
  2. `List Recent Files`: one Drive search for files created or modified in the window.
  3. `List All Folders` + `List Shortcuts`: folder tree, so each file is matched to a client by walking up parents, any depth, **including shortcut folders** (Leapmile's folder is a set of shortcuts).
  4. `Find New Files`: dedupe via workflow static data, skip > 100 MB, exclude listed subfolders, export Google Sheets/Docs to xlsx/pdf, sanitise names for SharePoint.
  5. Download → **Upload to SharePoint** via Microsoft Graph, conflict = rename.
  6. `Mark as Saved`: window advances only if every upload succeeded (failed files retry next hour).
  7. Teams alert node exists but is **disabled** (no Teams channel chosen yet).
- SharePoint: site **VA Documents** (`aiaccountant0.sharepoint.com/sites/VADocuments`), library Documents.
  - Site ID `aiaccountant0.sharepoint.com,03040be0-188b-4de3-bd6b-f23748470701,f67ceb24-693f-4ca0-b758-0276088ce00e`
  - Drive ID `b!4AsEA4sY4029a_I3SEcHASTrfPY_aaBMt1gCdgiM4A6O9mRfCUWcSKHQOsUl0jlA`
  - Upload credential: `Mrinal Korefi Teams` (generic OAuth2, delegated, id `YNrbNm2bXOaeYBQV`)
- Path convention: `Client Files/<exact SharePoint client folder>/<Client> - Google Drive/<YYYY-MM-DD>/<same subfolders as Drive>/<file>`
- Clients live: **Down The Rabbit Hole** (`Client Files/Down the Rabit Hole - Virtual Accounting`, note spelling "Rabit"), **Ayurpet / IFW** (`Client Files/Ayurpet - VA`), **Leapmile Logistics** (`Client Files/Leapmile-Korefi - Virtual Accounting Team`, Tally backups excluded).
- Tested end to end: 15/15 files landed correctly.
- Gap: Drive files are **not yet logged** in `document_uploads` (task T7.3).
- Several SharePoint clients have duplicate folders (KRRD, Rare You, RapidFix, Varsha Forgings, Tinidots, SLV Trades, Dental Radiology, Jitendra): confirm which one is active before adding.

### Not live yet
| Source | Status |
|---|---|
| Email `accounts@aiaccountant.com` | Blocked: `Mail.Read` (Delegated) added on Entra app **aia-gtm-bot**, waiting for admin consent from IT. Plan: OAuth2 credential `Outlook - accounts@aiaccountant.com`, read-only, attachments → SharePoint `<Client> - Email/<date>/<sender>/`, map client by sender email |
| Client-owned mailboxes (Forlife, KRRD, Horizon) | Parked. Forlife's address in the sheet is invalid (null MX); KRRD is Google Workspace (needs one-time Google sign-in) |
| Client SharePoint / OneDrive (Adroidex, Healthy Chef, Ragnayor) | Needs folder links and sharing confirmation |
| Portals (POS, Amazon, Shopify, Zomato, Swiggy, bank) | Mostly OTP. Fallback: scheduled report emails or accountant upload; human-in-the-loop |
| Granola meetings | Decided; workspace + API / webhook to set up |
| Airtel call recordings | API needs 50+ users; S3 auto-push is the likely route |

Source of client → data-source mapping: the sheet "VA_data_collection" (25 clients). It contains plaintext passwords; never copy them anywhere.

## 4. Supabase VA: what exists

| Table | Rows (approx.) | Notes |
|---|---|---|
| `clients` | 88 | `va_id`, `hubspot_deal_id`, `deal_stage`, `status`, `whatsapp_group_id`, `drive_folder_id` (empty), `council_enabled`, `parent_client_id` |
| `vas` | 4 | Accountants incl. `email`, `whatsapp_number`, `teams_chat_id` |
| `client_messages` | 14,329 | WhatsApp. `embedding` column exists but **0 embedded**. `body_tsv` for full-text |
| `conversations` | 71 | Tickets: status, tag (escalation / complaint / neutral / positive), fault, tones, summary, `sla_breached` |
| `council_verdicts` | 508 | GPT + Claude vote per message (new / continue / close / reopen) |
| `client_scores`, `client_score_history`, `score_weights` | small | Health score (service + mood) |
| `document_uploads` | 6,898 | WhatsApp files log (no `source` column yet) |
| `invoices` | 330 | Extracted invoice data, **no `client_id`** |
| `va_meeting_transcripts` | 7 | Teams fields; **0 linked** to a client |
| `message_processing_log` | | Council processing / retries |
| `renewal_jobs`, `addition_charges`, `client_pricing` | | Billing / renewals (Zoho, Razorpay), keyed by `hubspot_deal_id` |
| `settings`, `release_note_sends`, `flagged_messages`, `client_contacts` | | |

Views: `clients_meeting_picker`, `conversation_response_lags`.
The council / scoring code lives in an existing codebase (table comments reference `ARCHITECTURE.md`, `run.ts`). **Find it and extend it; do not rebuild.**

### ⚠️ Security findings (must fix first, Phase 0)
- `anon` can **read** `clients`, `client_messages`, `conversations`, `council_verdicts`, `client_scores`, `client_score_history` (policies `using (true)`) and has **full access** to `vas`.
- RLS is **off** on `client_contacts` and `addition_charges`.
- Something probably depends on these anon policies (existing dashboard / va-bot / n8n). Find and migrate it **before** applying `supabase/migrations/0001_phase0_security_and_columns.sql` (draft, not applied).

### Data quality
- Team members replying from personal numbers are stored as `direction = 'incoming'` (e.g. one VA number tagged as client 1,143 times). Fix: store all team numbers in `vas` and derive direction from it (about 22 numbers to confirm).

## 5. Metrics baseline (WhatsApp, Jan to Nov 2026, 22 inferred team numbers)

| Metric | Value |
|---|---|
| Thanks from clients | 296 (4.1% of 7,267 client messages) |
| Median first reply | 30 min overall, 24 min business hours (Mon to Sat 10:00 to 19:00 IST) |
| Answered within 7 days | 98% (3,463 / 3,522) |
| Proactive vs reactive | 28% / 72% |
| Median ticket resolution | 25.3 h (17 closed tickets only) |
| Top client words | otp, invoice, gst, payment, bank, call, account, update, tally, gstn, data, bill, month, email, sales |

Definitions in `specs/05-metrics.md`.

## 6. Product

### Roles
| Role | Sees | Can do |
|---|---|---|
| Senior Accountant | Own clients only (`clients.va_id`) | Work tickets, change bucket, view files / meetings / timeline, AI chat (own clients), approve agent drafts |
| Admin | All clients and accountants | + assign clients, manage users and roles, team dashboards |
| Engineer | All data + system | + config, council on/off, AI models and cost, failed jobs, logs, read-only "view as" |

Login: Microsoft SSO (Supabase Auth, Azure). Role in `app_metadata.role`. Accountant mapping: login email = `vas.email`.

### Buckets
Ops buckets are owned by Shadow Accounting and synced to HubSpot. Examples used by the team: **YTRO, DC, DS** (full list and meanings to be confirmed with leadership before building the bucket switch; the spec's `onboarding / active / at_risk / renewal_due` is a placeholder).

### Screens (design)
Mockup canvas: https://claude.ai/artifact/1izMkwQtvjeJRHRJMaZNyZ (a Figma version also exists, shared in the team group).
- **Senior Accountant Home**: KPIs, clients by bucket, my tickets with SLA, missing data + "Draft reminder", today feed, Ask AI.
- **Client 360**: profile, bucket switch (syncs to HubSpot), health / fee / renewal, tickets, AR / AP / Bank checklist by month, timeline (WhatsApp, Drive, email, meetings), contacts, client-scoped AI chat.
- **Admin Home**: team KPIs, workload per accountant, escalations, lowest health, top client topics, users and roles, client assignment, HubSpot sync status.
- **Engineer Home**: data source status, alerts, AI usage, failed jobs + retry, council toggle per client, config, "view as".
Brand: white / black / grey `#666666`, accent `#314DD0` for one primary action, Helvetica Neue.

### HubSpot sync (field ownership, one owner per field)
- HubSpot → Shadow: deals, stage, amount, payment; **deal won creates a client** (appears in Admin assignment).
- Shadow → HubSpot: bucket, assigned accountant, health score, open tickets / escalations (custom Deal properties `va_bucket`, `va_accountant`, `va_health_score`, `va_open_tickets`, `va_open_escalations`).

### Meetings (Granola)
1. Granola on accountants' laptops and phones records automatically (no bot), incl. Teams.
2. On meeting end: transcript, summary, action items.
3. Pushed to the backend (webhook; fallback: Granola API sync every 15 min).
4. Mapped to client by title `[Client name] - topic` or client email in the invite; else accountant picks the client.
5. Stored in `va_meeting_transcripts` with `client_id`; shows in timeline and AI chat.
Rules: title format, client email in invite, say "this call is being recorded for notes".
Note: phone calls on Android cannot be captured by Granola; iPhone only via Granola's dialer.

### Context agent
Next.js route, Vercel AI SDK tools over Supabase **as the logged-in user** (RLS applies). Tools: search messages (hybrid full-text + vector), tickets, files, meetings, client profile. Every claim cited (WhatsApp message + time, SharePoint link, meeting + minute). If not found, say so. Inspiration from leadership: one chat that acts across tools and **asks before sending anything** (later Communication agent on Teams).

## 7. Options evaluated and rejected (do not re-propose without new info)
| Option | Why not |
|---|---|
| Off-the-shelf practice management / CRM + helpdesk suites | No WhatsApp-group ticketing, Tally, GST or file collection for Indian VA |
| HubSpot Service Hub + Periskope tickets | Possible quick win, but no files / GST / checklist, and would duplicate the council |
| Combinely | UK / US stack (Xero, HMRC); no WhatsApp, Tally, GST |
| Nango | Syncs / webhooks are paid; free self-host is auth only |
| Activepieces | Same visual-flow model as n8n; no gain for collection |
| AI agent doing collection | Needs triggers anyway, costs per file, can skip files, prompt-injection risk |
| Jira | Internal tool; tickets live in Supabase |
| Wingman (personal AI assistant) | Per-person assistant, no team roles or data rules; borrow its "ask before acting" UX |

## 8. Build plan
Repo `va-platform` (Next.js scaffold + specs). Work through `specs/07-tasks.md`:
0. Security + data fixes (anon policies, RLS, team numbers, deps)
1. Auth (Microsoft SSO) + role shell
2. Senior Accountant Home + Client 360 + ticket actions
3. Metrics as SQL functions
4. Admin (team overview, users, assignment)
5. HubSpot two-way sync
6. Engineer (health, failed jobs, config, view as)
7. Context agent (embeddings, transcript linking, Drive files in `document_uploads`, chat with citations)
Later: email collection (Agent 1), compliance calendar, communication agent (approval before send), portals.

## 9. Open questions
1. Full bucket list and meanings (YTRO, DC, DS, ...).
2. Confirm the ~22 team WhatsApp numbers.
3. Where the existing council / scoring code lives, and who owns it.
4. What currently uses the Supabase anon key.
5. Storage for meeting transcript chunks (column vs new table): ask before creating anything.
6. OpenRouter model for the context agent.
7. Granola plan (Business vs Enterprise) and whether webhooks are available on it.
8. Teams channel for alerts.

## 10. Working conventions
- No new tables / views without approval. Columns listed in `specs/01-data-model.md` are pre-approved.
- Never run migrations on production without explicit approval.
- Service role key server-only. Browser and agent use the user's session.
- For edits to n8n workflows, describe changes as find & replace (node name, exact Find / Replace), never line numbers.
- No em dashes in UI copy or docs. Indian English.
- Never store or echo client passwords or credentials from the data-collection sheet.
