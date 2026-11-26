# Communication layer V1: how our team replies to clients

Status: plan, waiting for approval. Written 25 Nov 2026 from a read-only look at the code and Supabase VA.
Business answers received 25 Nov 2026 (see "Decisions"). Still open items are marked **[NEED]** and listed at the end.

## Decisions (25 Nov 2026)

- **Senior accountants:** Puneeth, Ajith, Gayathri, Deeksha. Gayathri and Deeksha have no interns.
- **Interns under Puneeth, by client:**

  | Intern | Clients (Shadow name / WhatsApp group) |
  | --- | --- |
  | Smriti | Down The Rabbit Hole, Ragnayor (`Nalin`), Healthy Chef (`Piyush`), BridgeLine Partners (`SA PREM NARAYAN`) |
  | Radha | Nirved Medicals and Anantha Enterprises (two entities, one WhatsApp group: `Nirved Medicals<>VA`), He Spoke (`Prem Sah`) |
  | Praveen | Wander Cafe, Amore Jayanagar |
  | Praveen and Nishi (shared) | Zam Steel (`Azam <> AIA`) |

- **Interns under Ajith, by client** (received 25 Nov 2026; subgroups go with their parent client):

  | Intern | Clients (Shadow name / WhatsApp group) |
  | --- | --- |
  | Noorain | Horizon Marketing (+5 subgroups), Nyvu (`Nyutech[Kiran]_AiA_2026`, +16 subgroups), BTS Enterprise <> VA (`BTS Enterprise`, added 25 Nov 2026) |
  | Sofiya | Tinidots and Ankur (one WhatsApp group: `Tinidots <> Virtual Accounting`, Shadow name `Sanjib`), Indofolks: Ayurpet <> VA (`Ayurpet`) with subgroup IndoFolk Wellness <> Annual Filing (added 25 Nov 2026), Noel George: Leon Enterprises |
  | Paras | Adroidex (`Debu Seth`), Erathem Curios |
  | Elina | Leapmile Logistics (+1 subgroup), Navekadashi (`Navaekadhasi Enterprises`, +13 subgroups), Interiors by Apricus Homes |

  KRRD: Ajith himself for now, an intern later (moved from Harshit to Ajith in Shadow on 25 Nov 2026).
  Data check: in these groups (last 14 days) the number ending 3697 sent 93 of 125 team replies across 6 groups,
  so it looks like Ajith's office number, the same pattern as Puneeth's **[NEED: confirm]**.
- **Interns reply from Puneeth's office number**, not their own phones. So a reply is credited to a person by
  **client**, not by number: a reply from the office number in a client's group belongs to that client's intern(s).
  Data check: in these 9 groups (last 14 days) the office number ending 8606 sent 145 of 192 team replies, across
  all 9 groups. Puneeth's own number sent none.
- **Office hours:** Monday to Friday, 09:30 to 18:30 IST. Saturday and Sunday are off.
- **Thresholds:** 30 office minutes = warning, 60 = breach.
- **Call outcomes:** the light V1 check as written below.
- **Red flags:** left out of V1.
- **ETA:** "today" or "by tomorrow" counts as clear.
- **Delivery:** everything goes to the senior accountant for now (interns have Teams; their own copy comes later).
  Day-end at 19:00, weekly on Monday at 10:00.
- **The core input is the conversation itself**: the WhatsApp messages between the intern and the client in each
  group (`client_messages`, grouped into tickets in `conversations`).

## Goal

Every client message in a WhatsApp group gets a timely reply with a clear ETA, promises are kept, problems reach
the client's senior accountant at once, and every intern gets honest day-end feedback on their replies. Senior
accountants get a weekly picture of their team.

## The V1 rules (agreed in the Teams chat on 25 Nov 2026)

1. Every reply has a clear ETA, for example "by 5 PM today".
2. First response within 30 to 60 minutes, **office hours only** (confirmed to Deeksha).
3. Outcomes from calls are posted and closed on the WhatsApp group.
4. Goes to the senior accountant immediately: red flag messages, missed ETAs, messages left open too long
   (time limit to be agreed).
5. Day-end feedback to interns on their replies, and a weekly overview to senior accountants.

Gayathri: "good enough for V1". Nobody objected.

## What exists today (read-only check, 25 Nov 2026)

| Rule | Exists | Gap |
| --- | --- | --- |
| 1. Clear ETA | Follow-ups job pulls promises and due times out of team replies (`lib/followups/prompt.ts`, `dates.ts`) | Nothing flags a reply with no ETA or a vague one. A promise with no date silently gets "2 business days, 19:00" |
| 2. First response | Teams reminder after 60 business minutes, escalation after 120 (`lib/teams/notify.ts`) | Office hours hard-coded Mon to Sat 10:00 to 19:00 (`lib/metrics/business-time.ts`), no holidays. Council `sla_breached` uses 24x7 clock time and never resets. Nothing per person |
| 3. Call outcomes | Nothing | Shadow has no call data |
| 4. Immediate alerts | Missed promises are detected (`lib/followups/job.ts`) | Missed-ETA cards go to admins (`routes.escalations()`), not the senior accountant. Council tags `escalation` / `complaint` and tone `angry` trigger no card at all |
| 5. Feedback and overview | Nothing | No daily or weekly job |

## Data we have

- Last 14 days: **625 team replies from 12 numbers**. 7 numbers are senior accountants (`vas.whatsapp_number`,
  268 replies). **5 numbers sent 357 replies (57%) and have no name**: most likely interns.
- `settings.team_whatsapp_numbers` is a plain comma list of 30 numbers. No names, no roles.
- Some replies come from the two **shared company numbers** connected to Periskope. One number can be used by
  several people, so the number alone cannot say who replied.
- Real working pattern: team replies run from about 09:00 to 19:00 IST, very few after 20:00.

## Design

### 1. Team map (needed by everything else)

A new settings key **`team_members`** (JSON, same pattern as `teams_personal`, no new table):

```json
{
  "office_numbers": [{ "number": "<last 10 digits>", "senior_va_id": "<Puneeth's vas.va_id>" }],
  "interns": [
    { "name": "Smriti", "senior_va_id": "<Puneeth>", "client_ids": ["<Down The Rabbit Hole>", "..."], "teams_email": null },
    { "name": "Praveen", "senior_va_id": "<Puneeth>", "client_ids": ["<Wander Cafe>", "<Amore>", "<Azam>"] },
    { "name": "Nishi", "senior_va_id": "<Puneeth>", "client_ids": ["<Azam>"] }
  ]
}
```

- Credit rule: a team reply in a client's group from an office number goes to that client's intern(s); a client
  with two interns (Zam Steel) credits both. A reply from a senior's own number goes to that senior.
- Senior accountants come from `vas` as today; this key adds interns and office numbers.
- `team_whatsapp_numbers` stays as is (detection). A number in `team_members` but not in the list is added to
  detection too.
- Replies from a `shared` number are counted under that number, not a person, until we can tell who sent them.
  Later option: va-bot copies Periskope's "performed by" user into the existing `client_messages.sender_name`
  (va-bot change, separate approval, no schema change).
- Phone numbers never appear in cards or reports, only names.

### 2. One office-hours rule

A new settings key **`office_hours`**: `{ "days": [1,2,3,4,5], "start": "09:30", "end": "18:30", "holidays": [] }`
(decided: Monday to Friday, 09:30 to 18:30). **[NEED]** holiday list, if any.

- Impact: today the code counts Saturday 10:00 to 19:00 as working time. After this change Saturday is off for the
  Teams reminders, follow-up due dates and response-time metrics too.

- `lib/metrics/business-time.ts` reads it (cached), so the Teams reminders, follow-ups and metrics all use it.
- A client message that arrives outside office hours starts its clock at the next office opening.
- The council SLA flag moves from 24x7 to office minutes. This is a behaviour change: old tickets keep their flag.

### 3. Response time (rule 2)

- **Response time** = office minutes from a client message to the first team reply in the same group after it.
  A client follow-up before any reply does not restart the clock.
- **30 office minutes, no reply:** reminder card to the client's senior accountant (the existing reminder, moved
  from 60 to 30). **[NEED]** confirm.
- **60 office minutes, no reply:** breach. Alert card to the senior accountant, copy to admins (existing
  escalation, moved from 120 to 60 and re-routed).
- Thresholds live in settings (`sla_minutes` = 60 stays; new `sla_warn_minutes` = 30).

### 4. ETA check (rule 1)

An AI check on each team reply, run in batches by the day-end job (no new column; results are only used in
reports). Not every reply needs an ETA: answers that finish the request, questions back to the client and plain
acknowledgements do not.

- **Input:** the team reply, the 5 messages before it in the group, the client name.
- **Output (JSON):** `needs_eta` (true / false), `eta` (`clear` / `vague` / `none`), `eta_text` (the words used,
  or null), `reason` (one line).
- **Clear** = a date or a time the client can hold us to ("by 5 PM today", "tomorrow by 12", "on 28 Nov").
  **Vague** = "will revert", "shortly", "soon", "in some time", "will check". **[NEED]** is "today" alone clear?
- **Failure cases:** model error or timeout means the reply is shown as "not checked", never as a fault.
  Hindi and Hinglish replies are handled. OTP or password text is skipped and never quoted.
- **Eval set before building:** 30 real team replies (10 clear, 10 vague, 10 that need no ETA), labelled by a
  senior accountant. Target: 90% agreement, and no "needs no ETA" reply marked as a fault.

### 5. Immediate alerts to the senior accountant (rule 4)

All go to the client's senior accountant (`routes.accountant(clients.va_id)`), with a copy to admins.
One card per event (ledger `teams_notifications`, existing kind `escalation`, ref prefixes below), office hours
only, outside hours they wait for the next opening.

| Event | Trigger | Ref |
| --- | --- | --- |
| Missed ETA | Follow-up promise goes `missed` (exists, today admins only) | `fu:<id>:missed` (existing) |
| No reply in 60 min | Section 3 | existing escalation ref |
| Left open too long | Ticket still open **[NEED: N office hours]** after our last promise with no update | `stale:<ticket>:<date>` |

Red flag alerts (council tag `escalation` / `complaint`, angry client) are **out of V1** by decision; the council
keeps tagging them, so they can be switched on later without new data.

### 6. Call outcomes (rule 3, light V1)

Shadow cannot see calls. V1 checks only what is written in the group:

- When a team reply says a call will happen or happened ("will call you", "spoke on call", "as discussed"),
  the day-end job looks for an outcome message from our team in the same group within **[NEED: N] office
  hours** ("as discussed, we will ...", a summary, a closing message).
- No outcome posted: listed in the intern's day-end feedback and the weekly overview. Not an immediate alert in V1.
- Later: Airtel call recordings or a call log would make this exact.

### 7. Day-end feedback (rule 5)

- **When:** Monday to Friday, 19:00 IST (cron `30 13 * * 1-5` UTC), new job route
  `/api/jobs/comms-report`, dry-run unless listed in `JOBS_WRITE_ONLY`.
- **Who gets it (V1):** the senior accountant, one card with a section per intern. The intern's own copy is
  switched on later, once interns message the Shadow bot in Teams.
- **Content per person, today only:**
  - replies sent, clients covered
  - median and slowest first response (office minutes), number over 60
  - replies that needed an ETA: clear / vague / none
  - promises due today: kept / missed
  - call mentions with no outcome posted
  - 2 or 3 example replies with one-line tips, each quoting the message and its time (citation rule)
- Tone: factual and short, praise first when earned. No ranking of interns against each other in the intern copy.

### 8. Weekly overview (rule 5)

- **When:** Monday 10:00 IST (cron `30 4 * * 1` UTC), same job with `?period=week`.
- **To:** each senior accountant, for their clients and their interns; admins get all.
- **Content:** the day-end numbers for the week per person and per client, trend against last week, top 3 slow or
  unhappy clients with links to the tickets in Shadow.

## Delivery and idempotency

- Teams cards through the existing `sendToTargets` (claim-before-send, one card per ref).
- Reports need a ledger entry too. `teams_notifications.kind` only allows `ticket`, `reminder`, `escalation`,
  `files`. **Proposal (needs approval, schema change):** add `report` to the check constraint.
  Rollback: put the old constraint back. Until approved, the report job keeps its sent list in a settings key
  `comms_reports_sent` (pattern of `follow_ups_scan`).
- Interns need to message the Shadow bot once in Teams ("hi") so we have their 1:1 chat, same as accountants.

## Security and privacy

- Reports quote client messages only to that client's senior accountant, admins and the intern who replied.
- Names, never phone numbers. No OTPs, passwords or credentials quoted (skip rule in the ETA check and reports).
- Service role stays server-side; every query is scoped by client ids or the person's mapped numbers.

## Build order (one step at a time, each verified before the next)

1. Settings `team_members` and `office_hours`, read by `lib/team` and `business-time.ts`. Tests.
   (`team_members` row created on 25 Nov 2026: 8 interns, 20 clients plus 36 subgroups, 2 office numbers.)
2. Response-time rule: 30 / 60 office minutes, alerts to the senior accountant. Tests, dry-run on a week of data.
3. Red flag and missed-ETA alerts to the senior accountant. Tests, dry-run.
4. ETA check prompt and eval script (30 labelled replies, real models). Stop if under 90%.
5. Day-end report job, dry-run for 3 days, seniors check the numbers, then switch on.
6. Weekly overview.
7. Call-outcome check.

## Success criteria (first 2 weeks live)

- Every team reply is credited to a person or a named shared number (0 unknown).
- Seniors receive red flag and missed-ETA cards within 15 minutes, office hours.
- Day-end numbers match a senior's manual check on 2 sample days.
- Share of replies with a clear ETA, and first response under 60 office minutes, both go up week on week.

## [NEED] still open

1. Ajith's interns: received. BTS Enterprise <> VA must be added to Shadow as a client; IndoFolk Wellness <>
   Annual Filing needs a Periskope number in the group; is Ankur part of Tinidots? Confirm the number ending 3697
   is Ajith's office number.
2. Anantha Enterprises: answered, it talks in the Nirved group. Leapmile: the main group has been silent since
   17 Nov (our number's last send there was refused); the work happens in the subgroup "Leapmile - Korefi -
   Accounting Group" (in Shadow, active). A third group "Leapmile - Payroll & Accounts Group" is in Periskope but
   not Shadow, last message 1 Sep 2026.
3. Confirm the office number ending 8606 is Puneeth's office number the interns use.
4. The company number ending 9596 is saved in `vas` as Prathiba's number, and it also sent 31 replies in 6 of the
   intern groups. Who uses it?
5. "Left open too long": proposed 1 full office day (9 office hours) with no update from our team after a promise.
6. Hours allowed to post a call outcome: proposed by end of the next office day.
7. Holiday list, if any.
8. Approval: `report` kind on `teams_notifications` (or keep the settings fallback).
