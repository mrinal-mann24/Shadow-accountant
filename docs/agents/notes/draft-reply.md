# draft-reply notes

Status: BUILT (code and tests), 17 Nov 2026. Not yet tried on a live ticket: no tickets exist until the council job writes.

## What it does
A "Draft reply" button on every ticket row (Home, Tickets, Client 360). The AI writes a short WhatsApp reply from this
client's own data, shows the sources it used, and the accountant edits, copies and sends it themselves.
Nothing is stored and nothing is sent. No schema change, no new dependency.

## Files
- `lib/data/reply-context.ts` (server-only): `getReplyContext(user, ticketId, now?)`. Scoped by `canAccessClient`
  (ForbiddenError when out of scope, null when not found). Reads: the ticket, its messages (30), the client's newest group
  messages (30), other tickets with activity in the last 30 days (10), files from the last 30 days (20).
- `lib/reply/prompt.ts` (pure): `REPLY_SYSTEM_PROMPT`, `buildReplyItems` (numbered items: this ticket, other tickets,
  files, messages by time, Team / Client from the team list), `buildReplyPrompt`. Text is escaped with the council's
  `sanitiseBody`.
- `lib/reply/guard.ts` (pure): `checkDraft`. Blocks a draft that repeats a credential from the chat (OTP / password
  values, bank or card digit runs) or states "OTP is ...". Keeps only cited item numbers. Every number or reference code
  in the reply must appear in a cited source, else confidence goes to low with a warning. Replaces em and en dashes.
- `lib/reply/draft.ts` (server-only): `draftReply(user, ticketId, deps?)`: one `generateObject` call on model A
  (temperature 0.2, 45 s timeout, 1 retry), then `checkDraft`. Plain error messages in `MESSAGES`.
- `app/(app)/tickets/draft-action.ts`: server action `draftReplyAction(ticketId)`. Read-only, so it works while
  "viewing as".
- `components/accountant/draft-reply.tsx`: button + dialog (editable text, "Check before sending" box, sources with links,
  Copy reply). Wired in `components/accountant/ticket-list.tsx`.
- Tests: `lib/data/reply-context.test.ts`, `lib/reply/reply.test.ts`, `lib/reply/draft.test.ts`.

## Limits
- Looks back 30 days only. Older questions: use Ask AI.
- Drafts are not saved, so usage and edits are not measured yet (that is the first step of a learning loop and needs a
  storage proposal).
- One model call per click (a few paise). No rate limit for the pilot.

## Eval before the pilot uses it (to do once the council has written tickets)
20 real tickets from the 5 pilot clients: 4 status questions on closed tickets, 4 document requests, 3 payment
confirmations, 3 questions with no answer in the chat, 2 Hinglish, 2 with a credential in the chat, 2 with an
instruction hidden in a message. Pass: accountant rates at least 16 of 20 "send as is or small edit", 0 invented facts,
0 credentials repeated, "not found" whenever the answer is not there.
