import 'server-only'
import type { JobResult } from '@/lib/jobs/guard'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { maskCredentials } from '@/lib/ai/redact'
import { DEFAULT_SLA_MINUTES } from '@/lib/scoring'
import { effectiveDirection, getTeamNumbers } from '@/lib/team'
import type { Insert, Update } from '@/lib/db/types'
import { combineVotes, validateVote } from './decide'
import { buildCouncilPrompt } from './prompt'
import {
  supabaseCouncilStore,
  type CouncilClient,
  type CouncilStore,
  type LogRow,
  type PendingMessage,
  type StoredConversation,
  type StoredVerdict,
} from './store'
import type { ContextMessage, CouncilContext, FinalDecision, Vote } from './types'
import { askModel, withOneRetry, type ModelVote, type VoteFn } from './vote'

export const RECENT_MESSAGES = 15
export const CLOSED_WINDOW_DAYS = 7
const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 100
/** Candidates read per page while looking for messages to vote on. */
export const CANDIDATE_PAGE = 300
/** Pages read at most per run (3000 candidates), so a huge dead backlog cannot make one run read forever. */
export const MAX_CANDIDATE_PAGES = 10
/**
 * No new message is started after this much time. One message can take about 125 s (two models in parallel,
 * 60 s timeout, one retry, plus DB calls), so 150 s keeps the run and the SLA step inside maxDuration 300.
 */
export const DEFAULT_BUDGET_MS = 150_000

/**
 * COUNCIL_START_DATE ("YYYY-MM-DD", an IST date): the council only reads messages from 00:00 IST that day.
 * Blank means no start date (every unprocessed message). Anything else throws, so a typo stops the run
 * instead of quietly voting on the whole history.
 */
export function parseCouncilStartDate(raw: string | undefined): string | null {
  const v = raw?.trim()
  if (!v) return null
  const utc = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null
  const valid = !!utc && !Number.isNaN(utc.getTime()) && utc.toISOString().slice(0, 10) === v
  if (!valid) throw new Error(`COUNCIL_START_DATE must be a date like 2026-10-19, got "${v}"`)
  return new Date(`${v}T00:00:00+05:30`).toISOString()
}

/** ?limit= for the job route: default 25, clamped to 1..100. */
export function parseCouncilLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

export type CouncilDeps = {
  store?: CouncilStore
  vote?: VoteFn
  teamNumbers?: Set<string>
  now?: () => Date
}

type MessageOutcome = {
  message_id: string
  client_id: string
  a: { model: string; decision: string; target: string | null }
  b: { model: string; decision: string; target: string | null }
  final: FinalDecision
  conversation_id: string | null
}

function toContextMessage(m: PendingMessage, team: Set<string>): ContextMessage {
  return {
    id: m.message_id,
    at: m.message_timestamp,
    sender: m.sender_name,
    direction: effectiveDirection(m, team),
    body: m.body,
  }
}

function later(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500)
}

function isDead(log: LogRow | undefined): boolean {
  return !!log && log.status === 'failed' && log.attempts >= (log.max_attempts || DEFAULT_MAX_ATTEMPTS)
}

/**
 * Ticket council batch. Picks unprocessed messages of council-enabled clients, oldest first, asks both
 * models, combines the votes and (only when write is true) records the verdict and applies it.
 * Idempotent: a message that already has a council_verdicts row is never voted on again; in write mode its
 * stored decision is finished instead (see finishStoredVerdict).
 * A dry run calls the models only when `vote` is true; otherwise it lists the messages it would vote on.
 */
export async function runCouncilJob(
  o: { write: boolean; limit: number; clientIds?: string[]; vote?: boolean; budgetMs?: number; since?: string | null },
  deps: CouncilDeps = {},
): Promise<JobResult> {
  const store = deps.store ?? supabaseCouncilStore(createAdminSupabase())
  const vote = deps.vote ?? askModel
  const now = deps.now ?? (() => new Date())
  const startedAt = now().getTime()
  const budgetMs = o.budgetMs ?? DEFAULT_BUDGET_MS
  const callModels = o.write || o.vote === true
  const result: JobResult = { job: 'council', dryRun: !o.write, processed: 0, written: 0, errors: [] }
  const outcomes: MessageOutcome[] = []
  const skipped: { message_id: string; reason: string }[] = []

  const clients = await store.councilClients(o.clientIds)
  if (!clients.length) {
    result.details = { clients: 0, outcomes, skipped, sla: { breached: [] } }
    return result
  }
  const byId = new Map<string, CouncilClient>(clients.map((c) => [c.client_id, c]))
  const clientIds = clients.map((c) => c.client_id)
  const team = deps.teamNumbers ?? (await getTeamNumbers())

  // 1. Pick candidates, page by page, skipping messages already voted on or out of retries, so a pile of
  //    dead messages at the head of the queue can never starve the batch. No writes in this step.
  const todo: PendingMessage[] = []
  const unfinished: { m: PendingMessage; verdict: StoredVerdict }[] = []
  const logs = new Map<string, LogRow>()
  const seen = new Set<string>()
  let dead = 0
  let pages = 0
  let exhausted = false
  while (todo.length < o.limit && pages < MAX_CANDIDATE_PAGES) {
    const page = await store.pendingMessages(clientIds, CANDIDATE_PAGE, pages * CANDIDATE_PAGE, o.since ?? null)
    pages++
    const fresh = page.filter((m) => !seen.has(m.message_id))
    for (const m of fresh) seen.add(m.message_id)
    const ids = fresh.map((m) => m.message_id)
    const [verdicts, pageLogs] = await Promise.all([store.existingVerdicts(ids), store.processingLog(ids)])
    for (const [id, l] of pageLogs) logs.set(id, l)
    for (const m of fresh) {
      if (todo.length >= o.limit) break
      const verdict = verdicts.get(m.message_id)
      if (verdict) {
        skipped.push({ message_id: m.message_id, reason: 'already has a verdict' })
        unfinished.push({ m, verdict })
        continue
      }
      const log = pageLogs.get(m.message_id)
      if (isDead(log)) {
        dead++
        skipped.push({ message_id: m.message_id, reason: `failed ${log!.attempts} times` })
        continue
      }
      todo.push(m)
    }
    if (page.length < CANDIDATE_PAGE) {
      exhausted = true
      break
    }
  }
  if (todo.length < o.limit && !exhausted && dead > 0) {
    result.errors.push(
      `queue: ${dead} of the oldest unprocessed messages have used up their retries; only ${todo.length} newer ` +
        `messages were found in ${pages * CANDIDATE_PAGE} candidates. Retry or review them on the engineer page.`,
    )
  }

  // Clients whose queue order is broken this run (a message failed): their later messages wait, so the next
  // run sees the failed one first and decisions stay in message order.
  const blocked = new Set<string>()

  // 2. Write mode: finish verdicts an earlier run stored but did not fully apply.
  if (o.write) {
    for (const { m, verdict } of unfinished) {
      try {
        await finishStoredVerdict(store, m, verdict, effectiveDirection(m, team), now().toISOString())
        const log = logs.get(m.message_id)
        if (log && log.status !== 'done') {
          await store.upsertLog({ message_id: m.message_id, attempts: log.attempts, status: 'done', error: null, processed_at: now().toISOString() })
        }
      } catch (e) {
        blocked.add(m.client_id)
        result.errors.push(`${m.message_id}: ${errorText(e)}`)
      }
    }
  }

  // 3. Vote. Dry run without `vote`: list the candidates only (no model calls, no cost).
  if (!callModels) {
    const sla = await markSlaBreaches(store, clientIds, false, now(), team, result)
    result.details = {
      clients: clients.length,
      outcomes,
      skipped,
      since: o.since ?? null,
      wouldVote: todo.map((m) => ({ message_id: m.message_id, client_id: m.client_id, at: m.message_timestamp })),
      note: 'Dry run without ?vote=1: no model calls were made.',
      sla,
    }
    return result
  }

  // Sequential on purpose: each decision can open a ticket the next message should continue.
  let stoppedEarly: { remaining: number } | undefined
  for (const [i, m] of todo.entries()) {
    if (now().getTime() - startedAt >= budgetMs) {
      stoppedEarly = { remaining: todo.length - i }
      break
    }
    if (blocked.has(m.client_id)) {
      skipped.push({ message_id: m.message_id, reason: 'an earlier message of this client failed in this run' })
      continue
    }
    const client = byId.get(m.client_id)!
    const prevAttempts = logs.get(m.message_id)?.attempts ?? 0
    result.processed++
    try {
      const closedSince = new Date(now().getTime() - CLOSED_WINDOW_DAYS * 86_400_000).toISOString()
      const [recent, convs] = await Promise.all([
        store.recentMessages(m, RECENT_MESSAGES),
        store.conversations(m.client_id, closedSince),
      ])
      const ctx: CouncilContext = {
        clientName: client.client_name,
        message: toContextMessage(m, team),
        recent: recent.map((r) => toContextMessage(r, team)),
        open: convs.open,
        recentlyClosed: convs.recentlyClosed,
      }
      const prompt = buildCouncilPrompt(ctx)
      const [ra, rb] = await Promise.all([
        withOneRetry(() => vote('A', prompt)),
        withOneRetry(() => vote('B', prompt)),
      ])
      const a = validateVote(ra.vote, ctx)
      const b = validateVote(rb.vote, ctx)
      const final = combineVotes(a, b)
      const outcome: MessageOutcome = {
        message_id: m.message_id,
        client_id: m.client_id,
        a: { model: ra.model, decision: a.decision, target: a.target_conversation_id },
        b: { model: rb.model, decision: b.decision, target: b.target_conversation_id },
        final,
        conversation_id: final.targetConversationId,
      }

      if (o.write) {
        outcome.conversation_id = await applyDecision({
          store, m, client, direction: ctx.message.direction, convs: [...convs.open, ...convs.recentlyClosed],
          ra, rb, a, b, final, at: now().toISOString(),
        })
        await store.upsertLog({
          message_id: m.message_id,
          attempts: prevAttempts + 1,
          status: 'done',
          error: null,
          processed_at: now().toISOString(),
        })
        result.written++
      }
      outcomes.push(outcome)
    } catch (e) {
      const msg = errorText(e)
      result.errors.push(`${m.message_id}: ${msg}`)
      if (o.write) {
        blocked.add(m.client_id)
        try {
          await store.upsertLog({ message_id: m.message_id, attempts: prevAttempts + 1, status: 'failed', error: msg })
        } catch (logErr) {
          result.errors.push(`${m.message_id}: could not write processing log: ${errorText(logErr)}`)
        }
      }
    }
  }

  // 4. SLA marking always runs: the time budget above leaves room for it.
  const sla = await markSlaBreaches(store, clientIds, o.write, now(), team, result)
  result.details = { clients: clients.length, since: o.since ?? null, outcomes, skipped, sla, ...(stoppedEarly ? { stoppedEarly } : {}) }
  return result
}

function touch(c: StoredConversation, m: PendingMessage, direction: 'incoming' | 'outgoing', at: string): Update<'conversations'> {
  return {
    last_message_at: later(c.last_message_at, m.message_timestamp),
    last_message_direction: direction,
    message_count: c.message_count + 1,
    updated_at: at,
  }
}

/**
 * Write order per message (each step makes a crash after it safe):
 *  - 'new': find or create the ticket first, then insert the verdict with final_conv_id set. A crash between
 *    the two leaves a ticket with no verdict; the next run votes again and reuses that ticket (same client,
 *    same client and opened_at = message time) instead of opening a duplicate.
 *  - others: insert the verdict first (so the message is never voted on twice), then update the ticket.
 *    A crash after the verdict is finished by finishStoredVerdict on the next run.
 *  - then mark the message processed.
 */
async function applyDecision(p: {
  store: CouncilStore
  m: PendingMessage
  client: CouncilClient
  direction: 'incoming' | 'outgoing'
  convs: StoredConversation[]
  ra: ModelVote
  rb: ModelVote
  a: Vote
  b: Vote
  final: FinalDecision
  at: string
}): Promise<string | null> {
  const { store, m, client, direction, convs, ra, rb, a, b, final, at } = p
  const src = final.source === 'B' ? b : a
  const verdict = (finalConvId: string | null): Insert<'council_verdicts'> => ({
    message_id: m.message_id,
    claude_model: ra.model,
    claude_decision: a.decision,
    claude_target_conv_id: a.target_conversation_id,
    claude_reasoning: a.reasoning,
    claude_latency_ms: ra.latencyMs,
    gpt_model: rb.model,
    gpt_decision: b.decision,
    gpt_target_conv_id: b.target_conversation_id,
    gpt_reasoning: b.reasoning,
    gpt_latency_ms: rb.latencyMs,
    // No `agreed`: it is a generated column in the database (gpt_decision = claude_decision and same target).
    // Sending it fails every insert with "cannot insert a non-DEFAULT value into column agreed".
    final_decision: final.decision,
    final_conv_id: finalConvId,
  })

  if (final.decision === 'new') {
    const conversationId =
      (await store.findCouncilTicket(m.client_id, m.message_timestamp)) ??
      (await store.createConversation({
        client_id: m.client_id,
        // conversations.opened_by only allows 'incoming' | 'outgoing' (DB check): who sent the opening message.
        opened_by: direction,
        va_id: client.va_id,
        status: 'open',
        opened_at: m.message_timestamp,
        last_message_at: m.message_timestamp,
        last_message_direction: direction,
        message_count: 1,
        title: maskCredentials(src.title).slice(0, 200) || null,
        summary: maskCredentials(src.summary),
        tag: src.tag,
        fault: src.fault,
        client_tone: src.client_tone,
        va_tone: src.va_tone,
      }))
    await store.insertVerdict(verdict(conversationId))
    await store.markMessage(m.message_id, conversationId, at)
    return conversationId
  }

  await store.insertVerdict(verdict(final.targetConversationId))
  const target = convs.find((c) => c.id === final.targetConversationId)
  let conversationId: string | null = null
  switch (final.decision) {
    case 'continue':
      conversationId = target!.id
      await store.updateConversation(conversationId, {
        ...touch(target!, m, direction, at),
        ...(src.summary ? { summary: maskCredentials(src.summary) } : {}),
      })
      break
    case 'close':
      conversationId = target!.id
      await store.updateConversation(conversationId, {
        ...touch(target!, m, direction, at),
        status: 'closed',
        closed_at: m.message_timestamp,
      })
      break
    case 'reopen':
      conversationId = target!.id
      await store.updateConversation(conversationId, {
        ...touch(target!, m, direction, at),
        status: 'open',
        closed_at: null,
        ...(src.summary ? { summary: maskCredentials(src.summary) } : {}),
      })
      break
    case 'no_action':
      break
  }
  await store.markMessage(m.message_id, conversationId, at)
  return conversationId
}

/**
 * A message has a verdict but is not marked processed: an earlier run failed part way. Re-apply the stored
 * decision before marking it. The ticket update is applied only when the ticket's last_message_at is older
 * than this message, which means the earlier update did not land (an applied update sets it to at least the
 * message time), so message_count is never bumped twice. The vote's new summary is not stored, so the
 * ticket keeps its current summary. A 'new' verdict always carries its ticket id (see applyDecision).
 */
export async function finishStoredVerdict(
  store: CouncilStore,
  m: PendingMessage,
  verdict: StoredVerdict,
  direction: 'incoming' | 'outgoing',
  at: string,
): Promise<void> {
  const { final_decision: decision, final_conv_id: convId } = verdict
  if (convId && (decision === 'continue' || decision === 'close' || decision === 'reopen')) {
    const c = await store.getConversation(convId)
    if (c && new Date(c.last_message_at).getTime() < new Date(m.message_timestamp).getTime()) {
      const status =
        decision === 'close'
          ? { status: 'closed', closed_at: m.message_timestamp }
          : decision === 'reopen'
            ? { status: 'open', closed_at: null }
            : {}
      await store.updateConversation(convId, { ...touch(c, m, direction, at), ...status })
    }
  }
  await store.markMessage(m.message_id, convId, at)
}

/**
 * Open tickets whose last attached message is incoming and older than sla_minutes are flagged, unless the
 * team replied in the client's chat within sla_minutes of that message. The reply check reads client_messages
 * directly (effective direction, any processing state), so a reply the council has not attached to this
 * ticket yet (backlog, no_action, or attached to another ticket) does not cause a false breach.
 */
async function markSlaBreaches(
  store: CouncilStore,
  clientIds: string[],
  write: boolean,
  now: Date,
  team: Set<string>,
  result: JobResult,
): Promise<{ slaMinutes: number; breached: string[]; answeredInTime: string[] }> {
  try {
    const slaMinutes = (await store.slaMinutes()) ?? DEFAULT_SLA_MINUTES
    // Clock time, 24x7 (accountants work any time): late once sla_minutes pass with no team reply.
    const before = new Date(now.getTime() - slaMinutes * 60_000).toISOString()
    const candidates = await store.slaCandidates(clientIds, before)
    const breached: string[] = []
    const answeredInTime: string[] = []
    for (let i = 0; i < candidates.length; i += 10) {
      const part = candidates.slice(i, i + 10)
      const replied = await Promise.all(
        part.map(async (c) => {
          const until = new Date(new Date(c.last_message_at).getTime() + slaMinutes * 60_000).toISOString()
          const msgs = await store.messagesBetween(c.client_id, c.last_message_at, until)
          return msgs.some((x) => effectiveDirection(x, team) === 'outgoing')
        }),
      )
      part.forEach((c, j) => (replied[j] ? answeredInTime : breached).push(c.id))
    }
    if (write && breached.length) await store.markSlaBreached(breached)
    return { slaMinutes, breached, answeredInTime }
  } catch (e) {
    result.errors.push(`sla: ${errorText(e)}`)
    return { slaMinutes: DEFAULT_SLA_MINUTES, breached: [], answeredInTime: [] }
  }
}
