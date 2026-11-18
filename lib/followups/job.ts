import 'server-only'
import type { JobResult } from '@/lib/jobs/guard'
import { appTimezone } from '@/lib/env'
import { businessMinutesBetween } from '@/lib/metrics/business-time'
import { effectiveDirection, getTeamNumbers } from '@/lib/team'
import { isClientFile } from '@/lib/data/documents'
import { cardAttachment, followUpCard } from '@/lib/teams/cards'
import { defaultConnector } from '@/lib/teams/connector'
import { siteUrl as defaultSiteUrl } from '@/lib/teams/env'
import { supabaseTeamsStore } from '@/lib/teams/store'
import type { NotificationKind, TeamsChannelMap, TeamsChannelRef, TeamsConnector, TeamsStore } from '@/lib/teams/types'
import { addBusinessDays, istDate, istEndOfDay, resolveDue } from './dates'
import { createFollowUpAI } from './extract'
import { isAckOnly, isHoldingReply, mightBeRepeatAsk, mightBeTeamFollowUp } from './prefilter'
import { followUpViews, supabaseFollowUpStore } from './store'
import {
  followUpCycle,
  followUpRef,
  isTableMissing,
  TABLE_MISSING_NOTE,
  type ClientScanState,
  type FollowUpAI,
  type FollowUpKind,
  type FollowUpRow,
  type FollowUpStore,
  type FollowUpView,
  type NewFollowUp,
  type OpenItem,
  type ScanMessage,
} from './types'

// follow-ups job (cron at 5, 20, 35 and 50 past the hour, so it never starts in the same minute as the council).
// The flow is the comment at the top of ./types.ts. Two steps:
//   1. scan: per pilot client, the new messages (by created_at) and files (by uploaded_at, re-read with a 48 h
//      overlap, ids already checked skipped) since its scan state, in message-time order. Team messages are checked
//      for promises and document requests, client messages for repeat asks; later messages and files resolve open
//      or missed items. An item that fails stops that client for this run (its watermark stays before it); if the
//      same item fails again on a later run it is skipped and reported, so one bad item never blocks a client.
//   2. alert: statuses (promise past due -> missed, at any hour) and Teams cards (business hours only), claimed in
//      teams_notifications before they are sent (same claim-before-send pattern as lib/teams/notify.ts), at most
//      MAX_SENDS_PER_RUN a run and none after ALERT_BUDGET_MS.
// A dry run writes nothing and calls no model: it lists the messages the prefilter would send to the model and
// the cards existing rows would get.

export const JOB = 'follow-ups'
/** No model call is started after this much time (route maxDuration is 300 s; one call can take 2 x 45 s). */
export const DEFAULT_BUDGET_MS = 100_000
/** No card is sent after this much time from the start of the run, so the run ends well inside 300 s. */
export const ALERT_BUDGET_MS = 230_000
export const MESSAGE_LIMIT = 200
export const UPLOAD_LIMIT = 100
/** Files are re-read this far before the files watermark: va-bot's catch-up logs old files with their WhatsApp time. */
export const UPLOAD_OVERLAP_MS = 48 * 60 * 60_000
/** Rows read from the overlap window at most (one PostgREST page). */
export const OVERLAP_UPLOAD_LIMIT = 1000
/** Checked upload ids are kept this long (and always while inside the overlap window), at most MAX_SEEN_UPLOADS. */
export const SEEN_UPLOADS_MS = 7 * 24 * 60 * 60_000
export const MAX_SEEN_UPLOADS = 1000
export const MAX_FAILURES_KEPT = 50
export const SKIPPED_NOTE = 'skipped after repeated failure'
export const TEAM_CONTEXT = 8
export const CLIENT_CONTEXT = 12
/** A document request is first chased at the end of this many business days after the request. */
export const FIRST_CHASE_BUSINESS_DAYS = 2
/** Chase reminders per document; the escalation follows the last one after the same rest. */
export const MAX_CHASES = 3
/** Business minutes between two chase reminders, and between the last one and the escalation (2 x 10:00 to 19:00). */
export const CHASE_EVERY_BUSINESS_MINUTES = 2 * 9 * 60
/** An item created more than this long after its source message was found in history: never alerted. */
export const HISTORY_MS = 24 * 60 * 60_000
/** Cards sent at most per run. The rest wait for the next run. */
export const MAX_SENDS_PER_RUN = 25
/** Word overlap (Jaccard) from which two items of the same kind and client count as the same item. */
export const DUPLICATE_SIMILARITY = 0.6

export const NO_CHANNELS_NOTE = 'Teams channels are not linked yet: no follow-up cards were sent.'
export const NO_CONNECTOR_NOTE = 'Teams bot env is not set: no follow-up cards were sent (statuses still updated).'

export type FollowUpsDeps = {
  store?: FollowUpStore
  ai?: FollowUpAI
  teamsStore?: TeamsStore
  /** null means the bot env is not set. */
  connector?: TeamsConnector | null
  views?: (ids: string[]) => Promise<FollowUpView[]>
  siteUrl?: string
  teamNumbers?: Set<string>
  timezone?: string
  /** Clock for the time budget (ms). Defaults to Date.now. */
  clock?: () => number
}

type NewMessage = Awaited<ReturnType<FollowUpStore['newMessages']>>[number]
type NewUpload = Awaited<ReturnType<FollowUpStore['newUploads']>>[number]
type ScanItem = { type: 'message'; at: number; m: NewMessage } | { type: 'upload'; at: number; u: NewUpload }
/**
 * An open (or missed) item, the time of its source message (-Infinity when unknown) and the source message id.
 * Evidence resolves it only when it is later than sourceMs.
 */
type OpenEntry = { item: OpenItem; sourceMs: number; sourceMessageId: string }

export type ClientScan = {
  client: string
  clientId: string
  messages: number
  uploads: number
  processed: number
  inserted: number
  resolved: number
  /** New promises or documents dropped as the same as an open or missed item from another message. */
  merged: number
  /** Items skipped after failing on two runs, as 'message <id>' or 'upload <id>'. */
  skipped?: string[]
  /** Dry run: messages the prefilter would send to the model. */
  candidates?: { message_id: string; at: string; check: 'team' | 'client' }[]
  watermark?: { messages?: string; uploads?: string }
  error?: string
}

export type FollowUpCardOutcome = {
  kind: NotificationKind
  what: 'due' | 'missed' | 'chase' | 'repeat'
  ref: string
  followUpId: string
  client: string
  channel: string
  status: 'would_send' | 'sent' | 'already_sent' | 'failed' | 'deferred'
}

const ms = (iso: string) => new Date(iso).getTime()

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500)
}

/** Thrown by the guarded model before a call when the time budget is spent. Not an item failure. */
class BudgetStop extends Error {}

/** Mon to Sat, 10:00 to 19:00 in tz (the same window as lib/metrics/business-time). */
export function inBusinessHours(now: Date, tz: string): boolean {
  return businessMinutesBetween(now, new Date(now.getTime() + 1), tz) > 0
}

// ---------------------------------------------------------------- duplicate items (pure, exported for tests)

/** Words that carry no meaning for "is this the same item" (articles, politeness, generic verbs). */
const FILLER = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'and', 'or', 'on', 'in', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'be',
  'this', 'that', 'these', 'those', 'it', 'its', 'our', 'your', 'my', 'me', 'us', 'we', 'you', 'i', 'him', 'her',
  'them', 'their', 'please', 'pls', 'plz', 'kindly', 'sir', 'mam', 'maam', 'madam', 'ji', 'share', 'send', 'provide',
  'give', 'upload', 'forward', 'submit', 'get', 'prepare', 'shared', 'sent', 'copy', 'copies', 'will', 'shall',
  'all', 'any', 'some', 'details', 'detail', 'related', 'regarding', 'kar', 'ka', 'ki', 'ke', 'do', 'de',
])

/** Lowercase, punctuation and extra spaces removed, filler words dropped. */
export function normaliseItem(item: string): string {
  return item
    .toLowerCase()
    .replace(/[^\p{L}\p{N}&\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(' ')
}

/** Same normalised text, or a word overlap (Jaccard) of DUPLICATE_SIMILARITY or more. */
export function sameItem(a: string, b: string): boolean {
  const x = normaliseItem(a)
  const y = normaliseItem(b)
  if (!x || !y) return a.trim().toLowerCase() === b.trim().toLowerCase()
  if (x === y) return true
  const A = new Set(x.split(' '))
  const B = new Set(y.split(' '))
  let common = 0
  for (const w of A) if (B.has(w)) common++
  return common / (A.size + B.size - common) >= DUPLICATE_SIMILARITY
}

// ---------------------------------------------------------------- scan state helpers

/** JSON with sorted keys, to compare two states. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** Keeps checked uploads still useful: inside the overlap window or the last SEEN_UPLOADS_MS, newest first, capped. */
function pruneSeen(seen: Record<string, string>, uploadsWm: string | undefined, nowMs: number): Record<string, string> | undefined {
  const cutoff = Math.min(nowMs - SEEN_UPLOADS_MS, (uploadsWm ? ms(uploadsWm) : nowMs) - UPLOAD_OVERLAP_MS)
  const kept = Object.entries(seen)
    .filter(([, at]) => ms(at) >= cutoff)
    .sort((a, b) => ms(b[1]) - ms(a[1]))
    .slice(0, MAX_SEEN_UPLOADS)
  return kept.length ? Object.fromEntries(kept) : undefined
}

function toOpenItem(r: FollowUpRow): OpenItem {
  return { id: r.id, kind: r.kind, item: r.item, created_at: r.created_at }
}

/** Message time of a message (created_at when the message time is unreadable). */
function messageMs(m: NewMessage): number {
  const t = ms(m.message_timestamp)
  return Number.isNaN(t) ? ms(m.created_at) : t
}

function guardAI(ai: FollowUpAI, overBudget: () => boolean): FollowUpAI {
  const check = () => {
    if (overBudget()) throw new BudgetStop('time budget')
  }
  return {
    team: async (...a) => {
      check()
      return ai.team(...a)
    },
    client: async (...a) => {
      check()
      return ai.client(...a)
    },
    delivered: async (...a) => {
      check()
      return ai.delivered(...a)
    },
  }
}

export async function runFollowUpsJob(
  o: { write: boolean; now: Date; since: string | null; budgetMs?: number; alertBudgetMs?: number },
  deps: FollowUpsDeps = {},
): Promise<JobResult> {
  try {
    return await runJob(o, deps)
  } catch (e) {
    // The table is a proposal until approved: answer 200 with a note instead of failing every 15 minutes.
    if (!isTableMissing(e)) throw e
    return { job: JOB, dryRun: !o.write, processed: 0, written: 0, errors: [], details: { note: TABLE_MISSING_NOTE } }
  }
}

async function runJob(
  o: { write: boolean; now: Date; since: string | null; budgetMs?: number; alertBudgetMs?: number },
  deps: FollowUpsDeps,
): Promise<JobResult> {
  const result: JobResult = { job: JOB, dryRun: !o.write, processed: 0, written: 0, errors: [] }
  const store = deps.store ?? supabaseFollowUpStore()
  const clock = deps.clock ?? Date.now
  const startedAt = clock()
  const budgetMs = o.budgetMs ?? DEFAULT_BUDGET_MS
  const overBudget = () => clock() - startedAt >= budgetMs
  const alertBudgetMs = o.alertBudgetMs ?? ALERT_BUDGET_MS
  const overAlertBudget = () => clock() - startedAt >= alertBudgetMs
  const notes: string[] = []
  const nowMs = o.now.getTime()

  const clients = await store.pilotClients()
  const scans: ClientScan[] = []
  let stoppedEarly: { remainingClients: number } | undefined

  if (clients.length) {
    const team = deps.teamNumbers ?? (await getTeamNumbers())
    // Never build the model client in a dry run: it needs the OpenRouter env and must not be called.
    const rawAI = o.write ? (deps.ai ?? createFollowUpAI()) : null
    const ai = rawAI ? guardAI(rawAI, overBudget) : null
    const loaded = await store.watermark()
    const state = { version: 2 as const, clients: { ...loaded.clients } }

    for (const [i, c] of clients.entries()) {
      if (overBudget()) {
        // Clients not finished, counting one stopped part way.
        stoppedEarly ??= { remainingClients: clients.length - i }
        break
      }
      const scan: ClientScan = { client: c.client_name, clientId: c.client_id, messages: 0, uploads: 0, processed: 0, inserted: 0, resolved: 0, merged: 0 }
      scans.push(scan)
      const before: ClientScanState = state.clients[c.client_id] ?? {}
      try {
        const seen: Record<string, string> = { ...(before.seenUploads ?? {}) }
        const uploadsFrom = before.uploads ?? o.since
        // The overlap window (48 h before the files watermark, not before the start date), for files va-bot logged
        // late with an old uploaded_at. Files already checked are skipped without a model call.
        let overlapFrom: string | null = null
        if (before.uploads) {
          const from = ms(before.uploads) - UPLOAD_OVERLAP_MS
          overlapFrom = new Date(o.since ? Math.max(from, ms(o.since)) : from).toISOString()
        }
        const [msgs, ups, overlap] = await Promise.all([
          store.newMessages(c.client_id, before.messages ?? null, o.since, MESSAGE_LIMIT),
          // Files before the start date can resolve nothing (no item is that old), so a first run starts there.
          store.newUploads(c.client_id, uploadsFrom, UPLOAD_LIMIT),
          ai && before.uploads && overlapFrom && ms(overlapFrom) < ms(before.uploads)
            ? store.newUploads(c.client_id, overlapFrom, OVERLAP_UPLOAD_LIMIT, before.uploads)
            : Promise.resolve([] as NewUpload[]),
        ])
        scan.messages = msgs.length
        scan.uploads = ups.length

        // When a read came back full, the other stream waits at its last row, so neither runs far ahead.
        const msgHorizon = ups.length >= UPLOAD_LIMIT ? ms(ups[ups.length - 1].uploaded_at) : Infinity
        const upHorizon = msgs.length >= MESSAGE_LIMIT ? ms(msgs[msgs.length - 1].created_at) : Infinity
        const msgIn = msgs.filter((m) => ms(m.created_at) <= msgHorizon)
        const upIn = ups.filter((u) => ms(u.uploaded_at) <= upHorizon)
        const inRead = new Set(upIn.map((u) => u.upload_id))
        const toCheck = [...overlap.filter((u) => !inRead.has(u.upload_id)), ...upIn].filter((u) => !seen[u.upload_id])
        // Message-time order, so an item exists before the later evidence that resolves it (a message first on a tie).
        const timeline: ScanItem[] = [
          ...msgIn.map((m) => ({ type: 'message' as const, at: messageMs(m), m })),
          ...toCheck.map((u) => ({ type: 'upload' as const, at: ms(u.uploaded_at), u })),
        ]
        timeline.sort((a, b) => a.at - b.at || (a.type === b.type ? 0 : a.type === 'message' ? -1 : 1))

        if (!ai) {
          scan.candidates = []
          for (const item of timeline) {
            if (item.type !== 'message') continue
            const body = (item.m.body ?? '').trim()
            if (!body) continue
            const dir = effectiveDirection(item.m, team)
            if (dir === 'outgoing' && mightBeTeamFollowUp(body)) {
              scan.candidates.push({ message_id: item.m.message_id, at: item.m.message_timestamp, check: 'team' })
            } else if (dir === 'incoming' && mightBeRepeatAsk(body)) {
              scan.candidates.push({ message_id: item.m.message_id, at: item.m.message_timestamp, check: 'client' })
            }
          }
          scan.processed = timeline.length
          result.processed += timeline.length
          continue
        }

        const open: OpenEntry[] = (await store.open(c.client_id))
          // A missed promise or document can still be delivered late; a repeat ask is answered only while open.
          .filter((r) => r.status === 'open' || (r.status === 'missed' && r.kind !== 'repeat_ask'))
          .map((r) => ({ item: toOpenItem(r), sourceMs: r.source_at ? ms(r.source_at) : -Infinity, sourceMessageId: r.source_message_id }))
        const ctx: ScanCtx = { store, ai, team, clientId: c.client_id, open, scan, result }
        const failures: Record<string, number> = { ...(before.failures ?? {}) }
        const doneMessages = new Set<string>()
        for (const item of timeline) {
          if (overBudget()) {
            stoppedEarly ??= { remainingClients: clients.length - i }
            notes.push(`${c.client_name}: stopped at the time budget, the rest waits for the next run.`)
            break
          }
          const key = item.type === 'message' ? `message:${item.m.message_id}` : `upload:${item.u.upload_id}`
          const label = key.replace(':', ' ')
          try {
            if (item.type === 'message') await scanMessage(ctx, item.m)
            else await scanUpload(ctx, item.u)
            delete failures[key]
          } catch (e) {
            if (e instanceof BudgetStop) {
              stoppedEarly ??= { remainingClients: clients.length - i }
              notes.push(`${c.client_name}: stopped at the time budget, the rest waits for the next run.`)
              break
            }
            if (isTableMissing(e)) throw e
            if ((failures[key] ?? 0) >= 1) {
              // Failed on an earlier run too: move past it (reported, never silent) so the client is not blocked.
              delete failures[key]
              ;(scan.skipped ??= []).push(label)
              result.errors.push(`${c.client_name}: ${label}: ${SKIPPED_NOTE}: ${message(e)}`)
            } else {
              failures[key] = 1
              scan.error = `${label}: ${message(e)}`
              result.errors.push(`${c.client_name}: ${scan.error}`)
              break
            }
          }
          if (item.type === 'message') doneMessages.add(item.m.message_id)
          else seen[item.u.upload_id] = item.u.uploaded_at
          scan.processed++
          result.processed++
        }

        // Watermarks move only over a run of done rows, in each read's own order.
        let messagesWm = before.messages
        for (const m of msgIn) {
          if (!doneMessages.has(m.message_id)) break
          messagesWm = m.created_at
        }
        let uploadsWm = before.uploads
        for (const u of upIn) {
          if (!seen[u.upload_id]) break
          uploadsWm = u.uploaded_at
        }
        const kept = Object.entries(failures).slice(-MAX_FAILURES_KEPT)
        const next: ClientScanState = {
          ...(messagesWm ? { messages: messagesWm } : {}),
          ...(uploadsWm ? { uploads: uploadsWm } : {}),
        }
        const seenKept = pruneSeen(seen, uploadsWm, nowMs)
        if (seenKept) next.seenUploads = seenKept
        if (kept.length) next.failures = Object.fromEntries(kept)
        if (canonical(next) !== canonical(before)) {
          state.clients[c.client_id] = next
          if (messagesWm !== before.messages || uploadsWm !== before.uploads) scan.watermark = { messages: messagesWm, uploads: uploadsWm }
          try {
            await store.saveWatermark({ version: 2, clients: { ...state.clients } })
          } catch (e) {
            result.errors.push(`save watermark (${c.client_name}): ${message(e)}`)
          }
        }
      } catch (e) {
        if (isTableMissing(e)) throw e
        scan.error = message(e)
        result.errors.push(`${c.client_name}: ${scan.error}`)
      }
    }
  }

  const alerts = await runAlerts(o, deps, store, result, notes, overAlertBudget)

  result.details = {
    clients: clients.length,
    since: o.since,
    scan: scans,
    merged: scans.reduce((n, s) => n + s.merged, 0),
    ...alerts,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    ...(notes.length ? { notes } : {}),
    ...(o.write ? {} : { note: 'Dry run: nothing was written and no model was called.' }),
  }
  return result
}

// ---------------------------------------------------------------- scan

type ScanCtx = {
  store: FollowUpStore
  ai: FollowUpAI
  team: Set<string>
  clientId: string
  open: OpenEntry[]
  scan: ClientScan
  result: JobResult
}

/** Items of a kind whose source message is before the evidence (by message time). */
function openOf(ctx: ScanCtx, kind: FollowUpKind, evidenceMs: number): OpenEntry[] {
  return ctx.open.filter((e) => e.item.kind === kind && e.sourceMs < evidenceMs)
}

async function resolveDone(
  ctx: ScanCtx,
  ids: string[],
  among: OpenEntry[],
  by: { at: string; resolved_message_id?: string; resolved_upload_id?: string },
): Promise<void> {
  const allowed = new Set(among.map((e) => e.item.id))
  for (const id of new Set(ids)) {
    if (!allowed.has(id)) continue // the model may only resolve the items it was shown
    await ctx.store.resolve(id, {
      status: 'done',
      resolved_by: 'ai',
      resolved_message_id: by.resolved_message_id ?? null,
      resolved_upload_id: by.resolved_upload_id ?? null,
      at: by.at,
    })
    const at = ctx.open.findIndex((e) => e.item.id === id)
    if (at >= 0) ctx.open.splice(at, 1)
    ctx.scan.resolved++
    ctx.result.written++
  }
}

async function insertItem(ctx: ScanCtx, row: NewFollowUp, sourceMs: number): Promise<void> {
  const item = row.item.trim()
  if (!item) return
  if (
    row.kind !== 'repeat_ask' &&
    ctx.open.some((e) => e.item.kind === row.kind && e.sourceMessageId !== row.source_message_id && sameItem(e.item.item, item))
  ) {
    ctx.scan.merged++ // the same promise or document asked again in another message: keep the first one
    return
  }
  const saved = await ctx.store.insert({ ...row, item })
  if (!saved) return // duplicate (source_message_id, kind, item): found by an earlier run
  ctx.scan.inserted++
  ctx.result.written++
  if (saved.status === 'open') ctx.open.push({ item: toOpenItem(saved), sourceMs, sourceMessageId: saved.source_message_id })
}

async function scanMessage(ctx: ScanCtx, m: NewMessage): Promise<void> {
  const body = (m.body ?? '').trim()
  // An empty body or an acknowledgement ("Ok sir", "Thanks") delivers, answers and promises nothing: no model call.
  if (!body || isAckOnly(body)) return
  const dir = effectiveDirection(m, ctx.team)
  const atMs = messageMs(m)
  const msg: ScanMessage = {
    message_id: m.message_id,
    client_id: m.client_id,
    conversation_id: m.conversation_id,
    body: m.body,
    direction: dir,
    sender_name: m.sender_name,
    message_timestamp: m.message_timestamp,
  }
  const evidence = { kind: 'message' as const, text: body, at: m.message_timestamp }
  const by = { at: m.message_timestamp, resolved_message_id: m.message_id }

  if (dir === 'outgoing') {
    // "Will check and revert" neither answers the client nor delivers anything.
    if (!isHoldingReply(body)) {
      // A later team reply answers a repeat ask: no model call.
      const asks = openOf(ctx, 'repeat_ask', atMs)
      await resolveDone(ctx, asks.map((e) => e.item.id), asks, by)

      const promises = openOf(ctx, 'promise', atMs)
      if (promises.length) {
        const check = await ctx.ai.delivered(evidence, promises.map((e) => e.item))
        await resolveDone(ctx, check.delivered_ids, promises, by)
      }
    }

    if (mightBeTeamFollowUp(body)) {
      const context = await ctx.store.contextBefore(ctx.clientId, m.message_timestamp, TEAM_CONTEXT)
      const found = await ctx.ai.team(msg, context, istDate(m.message_timestamp))
      const base = { client_id: ctx.clientId, conversation_id: m.conversation_id, source_message_id: m.message_id }
      for (const p of found.promises) {
        await insertItem(ctx, { ...base, kind: 'promise', item: p.item, due_at: resolveDue(p.due_date, p.due_time, m.message_timestamp) }, atMs)
      }
      if (found.document_requests.length) {
        const firstChase = istEndOfDay(addBusinessDays(m.message_timestamp, FIRST_CHASE_BUSINESS_DAYS))
        for (const d of found.document_requests) {
          await insertItem(ctx, { ...base, kind: 'document', item: d.item, due_at: firstChase }, atMs)
        }
      }
    }
    return
  }

  const docs = openOf(ctx, 'document', atMs)
  if (docs.length) {
    const check = await ctx.ai.delivered(evidence, docs.map((e) => e.item))
    await resolveDone(ctx, check.delivered_ids, docs, by)
  }
  if (mightBeRepeatAsk(body)) {
    const context = await ctx.store.contextBefore(ctx.clientId, m.message_timestamp, CLIENT_CONTEXT)
    const found = await ctx.ai.client(msg, context, ctx.open.map((e) => e.item))
    if (found.repeat_ask) {
      await insertItem(
        ctx,
        { client_id: ctx.clientId, conversation_id: m.conversation_id, source_message_id: m.message_id, kind: 'repeat_ask', item: found.repeat_ask.item, due_at: null },
        atMs,
      )
    }
  }
}

async function scanUpload(ctx: ScanCtx, u: NewUpload): Promise<void> {
  if (!u.file_name.trim()) return
  // Same rule as the client page (lib/data/documents): a file is the team's when its sender is a team number.
  const teamFile = !isClientFile({ sender_phone: u.sender_phone }, ctx.team)
  const targets = openOf(ctx, teamFile ? 'promise' : 'document', ms(u.uploaded_at))
  if (!targets.length) return
  const check = await ctx.ai.delivered({ kind: 'file', text: u.file_name, at: u.uploaded_at }, targets.map((e) => e.item))
  await resolveDone(ctx, check.delivered_ids, targets, { at: u.uploaded_at, resolved_upload_id: u.upload_id })
}

// ---------------------------------------------------------------- alerts

type Candidate = FollowUpRow & { source_at: string }

type PlannedCard = { kind: 'reminder' | 'escalation'; what: FollowUpCardOutcome['what']; ref: string; route: 'accountant' | 'escalations' }

/** One follow-up's cards; `mark` is recorded once every card is out (or was already sent by another run). */
type Task = { row: Candidate; cards: PlannedCard[]; mark: 'reminded' | 'escalated' }

/**
 * The cards a follow-up needs now (business hours only). Refs carry the alert cycle (the due date's day), so the
 * cards after an extend (new due_at, escalated_at and reminder_count reset) are new claims:
 *   due / missed: n = cycle; chase: n = cycle * 10 + k (k = 1..3); repeat: n = 0.
 */
function planTask(row: Candidate, status: FollowUpRow['status'], nowMs: number, today: string, businessHours: boolean, tz: string): Task | null {
  if (!businessHours) return null // every card waits for 10:00 to 19:00 Mon to Sat; statuses are already updated
  const cycle = followUpCycle(row.due_at)
  if (row.kind === 'promise') {
    if (status === 'missed') {
      if (row.escalated_at) return null
      return { row, mark: 'escalated', cards: [{ kind: 'escalation', what: 'missed', ref: followUpRef(row.id, 'missed', cycle), route: 'escalations' }] }
    }
    if (status === 'open' && row.due_at && ms(row.due_at) >= nowMs && istDate(row.due_at) === today && row.reminder_count === 0) {
      return { row, mark: 'reminded', cards: [{ kind: 'reminder', what: 'due', ref: followUpRef(row.id, 'due', cycle), route: 'accountant' }] }
    }
    return null
  }
  if (row.kind === 'document') {
    if (status !== 'open' || !row.due_at || ms(row.due_at) > nowMs) return null
    const rested =
      !row.last_reminded_at || businessMinutesBetween(new Date(row.last_reminded_at), new Date(nowMs), tz) >= CHASE_EVERY_BUSINESS_MINUTES
    if (!rested) return null
    if (row.reminder_count >= MAX_CHASES) {
      if (row.escalated_at) return null
      return { row, mark: 'escalated', cards: [{ kind: 'escalation', what: 'missed', ref: followUpRef(row.id, 'missed', cycle), route: 'escalations' }] }
    }
    // k is 1-based: the card shows "reminder k".
    const ref = followUpRef(row.id, 'chase', cycle * 10 + row.reminder_count + 1)
    return { row, mark: 'reminded', cards: [{ kind: 'reminder', what: 'chase', ref, route: 'accountant' }] }
  }
  // repeat_ask: escalation and the accountant's reminder together.
  if (status !== 'open' || row.escalated_at) return null
  const ref = followUpRef(row.id, 'repeat')
  return {
    row,
    mark: 'escalated',
    cards: [
      { kind: 'escalation', what: 'repeat', ref, route: 'escalations' },
      { kind: 'reminder', what: 'repeat', ref, route: 'accountant' },
    ],
  }
}

async function runAlerts(
  o: { write: boolean; now: Date },
  deps: FollowUpsDeps,
  store: FollowUpStore,
  result: JobResult,
  notes: string[],
  overAlertBudget: () => boolean,
): Promise<{ alerts: Record<string, unknown> }> {
  const tz = deps.timezone ?? appTimezone()
  const nowMs = o.now.getTime()
  const nowIso = o.now.toISOString()
  const today = istDate(nowIso)
  // End of the IST calendar day, so a promise due tonight after 19:00 still gets its reminder today.
  const dueBefore = new Date(`${today}T23:59:59.999+05:30`).toISOString()
  const businessHours = inBusinessHours(o.now, tz)

  const candidates = await store.alertCandidates(dueBefore)
  result.processed += candidates.length
  const missed: string[] = []
  const history: string[] = []
  const tasks: Task[] = []
  for (const row of candidates) {
    let status = row.status
    if (row.kind === 'promise' && status === 'open' && row.due_at && ms(row.due_at) < nowMs) {
      if (o.write) {
        try {
          // resolved_by 'ai' records who set it; a missed promise can still be marked done or extended later.
          await store.resolve(row.id, { status: 'missed', resolved_by: 'ai', at: nowIso })
          result.written++
        } catch (e) {
          if (isTableMissing(e)) throw e
          result.errors.push(`mark missed ${row.id}: ${message(e)}`)
          continue
        }
      }
      missed.push(row.id)
      status = 'missed'
    }
    if (ms(row.created_at) - ms(row.source_at) > HISTORY_MS) {
      history.push(row.id)
      // Never alerted: escalated_at (with no card) takes it out of later alertCandidates reads.
      if (o.write && !row.escalated_at) {
        try {
          await store.markEscalated(row.id, nowIso)
          result.written++
        } catch (e) {
          if (isTableMissing(e)) throw e
          result.errors.push(`mark history ${row.id}: ${message(e)}`)
        }
      }
      continue
    }
    const task = planTask(row, status, nowMs, today, businessHours, tz)
    if (task) tasks.push(task)
  }

  const summary: Record<string, unknown> = { candidates: candidates.length, missed, history: history.length, businessHours }
  if (!tasks.length) return { alerts: { ...summary, cards: [] } }

  const teamsStore = deps.teamsStore ?? supabaseTeamsStore()
  const map = await teamsStore.channels()
  if (!map) {
    notes.push(NO_CHANNELS_NOTE)
    return { alerts: { ...summary, cards: [], waiting: tasks.length } }
  }
  const connector = 'connector' in deps ? (deps.connector ?? null) : defaultConnector()
  if (o.write && !connector) {
    notes.push(NO_CONNECTOR_NOTE)
    return { alerts: { ...summary, cards: [], waiting: tasks.length } }
  }

  const views = new Map((await (deps.views ?? followUpViews)(tasks.map((t) => t.row.id))).map((v) => [v.id, v]))
  const site = deps.siteUrl ?? defaultSiteUrl()

  // Routing: the accountant's own channel, else Escalations with one error line per unlinked accountant.
  const unlinked = new Map<string, { name: string; count: number }>()
  const unroutable: string[] = []
  const route = (p: PlannedCard, v: FollowUpView): TeamsChannelRef | null => {
    if (p.route === 'accountant') {
      const own = v.vaId ? map.accountants[v.vaId] : undefined
      if (own) return own
      const key = v.vaId ?? `(no accountant) ${v.clientName}`
      const entry = unlinked.get(key) ?? { name: v.vaId ? `${v.vaName ?? v.vaId} (${v.vaId})` : `no accountant for ${v.clientName}`, count: 0 }
      entry.count++
      unlinked.set(key, entry)
    }
    return map.escalations
  }

  const cards: FollowUpCardOutcome[] = []
  let attempts = 0
  let deferred = 0
  let budgetDeferred = 0
  for (const t of tasks) {
    const v = views.get(t.row.id)
    if (!v) {
      result.errors.push(`follow-up ${t.row.id}: not found for its card`)
      continue
    }
    let complete = true
    for (const p of t.cards) {
      const channel = route(p, v)
      if (!channel) {
        unroutable.push(`${p.kind} ${p.ref} (${v.clientName})`)
        complete = false
        continue
      }
      const outcome: FollowUpCardOutcome = {
        kind: p.kind,
        what: p.what,
        ref: p.ref,
        followUpId: t.row.id,
        client: v.clientName,
        channel: channel.name ?? channel.id,
        status: 'would_send',
      }
      cards.push(outcome)
      if (attempts >= MAX_SENDS_PER_RUN) {
        outcome.status = 'deferred'
        deferred++
        complete = false
        continue
      }
      if (!o.write) {
        attempts++
        continue
      }
      if (overAlertBudget()) {
        outcome.status = 'deferred'
        budgetDeferred++
        complete = false
        continue
      }
      outcome.status = await sendOne(p, v, channel, map, teamsStore, connector!, site, result.errors, () => attempts++)
      if (outcome.status === 'sent') result.written++
      if (outcome.status !== 'sent' && outcome.status !== 'already_sent') complete = false
    }
    if (o.write && complete) {
      try {
        if (t.mark === 'reminded') await store.markReminded(t.row.id, nowIso)
        else await store.markEscalated(t.row.id, nowIso)
      } catch (e) {
        result.errors.push(`mark ${t.mark} ${t.row.id}: ${message(e)}`)
      }
    }
  }

  for (const [, u] of unlinked) {
    result.errors.push(`No Teams channel linked for accountant ${u.name}: ${u.count} follow-up card(s) sent to Escalations instead.`)
  }
  if (unroutable.length) {
    result.errors.push(`No Teams channel to send to (link the accountant or Escalations channel): ${unroutable.join('; ')}`)
  }
  if (budgetDeferred) notes.push(`Alerts stopped at the time budget: ${budgetDeferred} card(s) wait for the next run.`)
  return {
    alerts: {
      ...summary,
      cards,
      ...(deferred ? { deferred } : {}),
      ...(budgetDeferred ? { stoppedAtBudget: budgetDeferred } : {}),
    },
  }
}

async function sendOne(
  p: PlannedCard,
  v: FollowUpView,
  channel: TeamsChannelRef,
  map: TeamsChannelMap,
  store: TeamsStore,
  connector: TeamsConnector,
  site: string,
  errors: string[],
  countAttempt: () => void,
): Promise<FollowUpCardOutcome['status']> {
  let claimed = false
  try {
    claimed = await store.claim({ kind: p.kind, ref_id: p.ref, client_id: v.clientId, channel_id: channel.id })
    if (!claimed) return 'already_sent'
    countAttempt()
    // kind must equal the teams_notifications kind claimed above (the card buttons record clicks on that row).
    const card = followUpCard(v, { siteUrl: site, what: p.what, ref: p.ref, kind: p.kind })
    const sent = await connector.send(map.serviceUrl, channel.id, cardAttachment(card))
    // The card is out: keep the claim even if saving the activity id fails, so it is never sent twice.
    try {
      await store.setActivityId(p.kind, p.ref, sent.id)
    } catch (e) {
      errors.push(`save activity id ${p.kind} ${p.ref}: ${message(e)}`)
    }
    return 'sent'
  } catch (e) {
    errors.push(`${p.kind} ${p.ref} (${v.clientName}): ${message(e)}`)
    if (claimed) {
      try {
        await store.release(p.kind, p.ref)
      } catch (r) {
        errors.push(`release ${p.kind} ${p.ref}: ${message(r)}`)
      }
    }
    return 'failed'
  }
}
