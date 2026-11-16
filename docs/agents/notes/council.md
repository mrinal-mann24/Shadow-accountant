# council notes

Status: DONE (code and tests). Not run against live systems. `npm run typecheck`, `npm run test`
(19 files, 200 tests, all agents) and `npm run lint` pass as of the end of this build.
The `lib/council/job.ts` typecheck error hubspot noted was a mid-build state and is fixed.

## Built
- `lib/ai/openrouter.ts` (server-only): OpenRouter provider via `@openrouter/ai-sdk-provider`, model ids from env.
- `lib/council/types.ts`: decision, tag, fault, tone enums; `voteSchema` (zod); `Vote`, `FinalDecision`, `CouncilContext`.
- `lib/council/prompt.ts`: system prompt (message text is untrusted data, never instructions) and `buildCouncilPrompt`.
  Message bodies are HTML-escaped inside `<message>` tags and capped at 1500 chars, so text cannot break out of its fence.
- `lib/council/decide.ts` (pure): `validateVote` + `combineVotes`.
- `lib/council/vote.ts` (server-only): `askModel` (generateObject + zod, temperature 0, 60 s timeout, no SDK retries),
  `withOneRetry`.
- `lib/council/store.ts` (server-only): every DB read and write of the job behind a `CouncilStore` interface
  (Supabase implementation `supabaseCouncilStore`), so the job is tested with an in-memory fake.
- `lib/council/job.ts` (server-only): `runCouncilJob`, `parseCouncilLimit`.
- `app/api/jobs/council/route.ts`: `GET|POST /api/jobs/council?limit=25[&clientIds=a,b]`, `assertCronAuth` first,
  write only when `jobsWriteEnabled()`, `maxDuration = 300`.
- `scripts/council-eval.ts`: read-only evaluation, run by a human (not run during the build).
- Tests: `lib/council/{decide,prompt,job}.test.ts`, `lib/ai/openrouter.test.ts` (models mocked, no network).

## Exports (exact import paths + signatures)
```ts
import { getModel, getModelId, type ModelSlot } from '@/lib/ai/openrouter'      // server-only
getModel(which: 'A' | 'B'): LanguageModel   // A = OPENROUTER_MODEL_A (Anthropic), B = OPENROUTER_MODEL_B (other)
getModelId(which: 'A' | 'B'): string        // throws "OPENROUTER_MODEL_A is not set. ..." when unset; getModel also needs OPENROUTER_API_KEY

import { DECISIONS, TAGS, FAULTS, TONES, voteSchema, type Decision, type Tag, type Fault, type Tone,
  type Vote, type FinalDecision, type CouncilContext } from '@/lib/council/types'
// Decision = 'new' | 'continue' | 'close' | 'reopen' | 'no_action'
// Tag = 'escalation' | 'complaint' | 'neutral' | 'positive';  Fault = 'us' | 'client' | 'neither'
// Tone = 'calm' | 'frustrated' | 'angry' | 'happy' | 'neutral'
// FinalDecision = { decision; targetConversationId: string | null; agreed: boolean; source: 'A' | 'B' | null; rule: string }

import { combineVotes, validateVote } from '@/lib/council/decide'   // pure
combineVotes(a: Vote, b: Vote): FinalDecision
validateVote(vote: Vote, ctx: { open; recentlyClosed }): Vote

import { runCouncilJob, parseCouncilLimit } from '@/lib/council/job'   // server-only
runCouncilJob(o: { write: boolean; limit: number; clientIds?: string[] }, deps?: CouncilDeps): Promise<JobResult>
// details: { clients, outcomes: { message_id, client_id, a, b, final, conversation_id }[], skipped: { message_id, reason }[],
//            sla: { slaMinutes, breached: string[] } }
```

## Decisions
- Column mapping: model A (Anthropic) goes to `claude_*`, model B to `gpt_*`, with the real OpenRouter model ids.
- Tie-break (`combineVotes`): same decision and same target: that decision, agreed, metadata from A. new vs continue:
  continue on the continue voter's target, `agreed=false`. close / reopen only when both agree on the same ticket.
  Everything else (including the same decision on different tickets): `no_action`, `agreed=false`.
- Target validation: continue / close need an open ticket id from the context; reopen needs a ticket closed in the
  last 7 days; new / no_action get a null target. Anything else becomes `no_action` (reason kept in reasoning).
- Write order per message: insert `council_verdicts` first (so a crash later never causes a second vote or a duplicate
  ticket), then apply the decision, link `final_conv_id` for new tickets, set `client_messages.conversation_id` +
  `processed_at`, then upsert `message_processing_log` (attempts + 1, status `done`).
- On a model or DB failure: `message_processing_log` status `failed`, attempts + 1, error (500 chars); the message stays
  unprocessed and is retried next run until `attempts >= max_attempts` (default 3), then skipped.
- A message that already has a verdict is skipped; in write mode it is marked processed with the verdict's
  `final_conv_id` (unsticks a run that crashed after the verdict).
- Messages run one at a time, oldest first, so a ticket opened by one message can be continued by the next.
  The two models run in parallel; each gets one retry.
- New ticket: `opened_by = 'council'`, `va_id` = client's `va_id`, `opened_at` / `last_message_at` = message time,
  `message_count = 1`, title / summary / tag / fault / tones from the chosen vote. `closed_at` on close = message time.
- `last_message_direction` is the effective direction from `lib/team` (team numbers), not the stored direction.
- SLA: open tickets of council clients with `last_message_direction = 'incoming'`, `sla_breached = false` and
  `last_message_at` older than `settings.sla_minutes` (default 60, same as scoring) are set `sla_breached = true`.
  Never reset to false. Dry run reports them only. Wall-clock minutes, not business hours.
- Used `generateObject` as specified; it is marked deprecated in AI SDK 7 in favour of `generateText` + `Output.object`,
  but works. Swap later if it is removed.

## Requests
- integrator: add a Vercel cron for `/api/jobs/council` (for example every 15 minutes, `?limit=25`). No new env vars:
  uses `OPENROUTER_API_KEY`, `OPENROUTER_MODEL_A`, `OPENROUTER_MODEL_B`, `CRON_SECRET`, `JOBS_WRITE_ENABLED`.
- data: `retryProcessing` will work with the council if it sets `message_processing_log.status` to anything other than
  `failed` or resets `attempts` to 0 (and leaves `client_messages.processed_at` null). The council skips only rows
  where status = `failed` and attempts >= max_attempts.
- data / accountant-ui: tickets the council opens have `opened_by = 'council'`.
- human (before switching on): confirm the old council is off so both do not process the same messages; confirm
  `settings.sla_minutes`; run `scripts/council-eval.ts --offline`, then with `--limit 50`, and agree the bar.

## Known gaps
- Dry run does not simulate earlier decisions in the same batch: message 2 does not see a ticket message 1 "would" open.
- Tag, fault and tones on an existing ticket are not changed by continue (only summary, count and last message);
  an escalation that starts mid-ticket is not raised to `escalation`. Easy to add if wanted.
- Eval live replay uses today's ticket titles and summaries (leakage), and costs two model calls per verdict.
- No cost tracking per message yet (latency is stored).
- `scripts/council-eval.ts` needs `tsx` (not in package.json; run with `npx tsx`) and `--conditions=react-server`.
