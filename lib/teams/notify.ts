import 'server-only'
import type { JobResult } from '@/lib/jobs/guard'
import { appTimezone } from '@/lib/env'
import { businessMinutesBetween } from '@/lib/metrics/business-time'
import { getTeamNumbers } from '@/lib/team'
import { isClientFile } from '@/lib/data/documents'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { cardAttachment, escalationCard, filesCard, reminderCard, ticketCard } from './cards'
import { defaultConnector } from './connector'
import { siteUrl as defaultSiteUrl } from './env'
import { appUserByEmail } from './identity'
import { loadRoutes } from './routing'
import { supabaseTeamsStore } from './store'
import { supabaseNotifyReads, type NotifyReads, type PilotClient, type UploadForNotify } from './notify-store'
import type {
  AdaptiveCard,
  DeliveryTarget,
  NotificationAction,
  NotificationKind,
  NotificationRow,
  ResolveUser,
  TeamsConnector,
  TeamsStore,
  TicketForCard,
} from './types'

// teams-notify job (cron every 5 minutes). Posts cards into the Teams channels linked in settings
// 'teams_channels': new tickets, reminders for client messages waiting on a reply, escalations, and new client
// files. Every card is claimed in teams_notifications before it is sent, so two overlapping runs never send
// the same card twice; a failed send releases its claim so the next run retries it.
//
// Claim before send, the trade-off: a missed card is preferred over a duplicate.
//   * A crash (or a timeout of the whole function) between claim and send leaves a row with activity_id null
//     and no card in Teams. Ticket / reminder / escalation rows are retried by a later run once the row is older
//     than STALE_CLAIM_MS (see staleRefs). Files rows are not retried: that card is lost.
//   * A send whose response fails or times out is released and resent next run, even if Teams did post it,
//     so that card can show up twice.
//   * A send that worked but whose activity id could not be saved also leaves activity_id null, so the stale
//     retry can post it a second time (rare: the save is one update right after the send).

export const JOB = 'teams-notify'
/** Business minutes a client message may wait before the accountant channel gets a reminder. */
export const REMIND_AFTER_MINUTES = 60
/** Business minutes a client message may wait before Escalations gets a card. */
export const ESCALATE_AFTER_MINUTES = 120
/** Cards sent at most per run. The rest wait for the next run. */
export const MAX_SENDS_PER_RUN = 25
/** Only tickets and files created this recently get a "new" card. */
export const NEW_WINDOW_MS = 2 * 60 * 60_000
/** A "new" ticket must also have opened this recently, so the 30-day history backfill never floods Teams. */
export const OPENED_WINDOW_MS = 24 * 60 * 60_000
/** Waiting tickets are looked at only when the last client message is this recent. */
export const WAITING_WINDOW_MS = 7 * 24 * 60 * 60_000
/** A claimed ticket / reminder / escalation row still without an activity id this long after sent_at is a lost send. */
export const STALE_CLAIM_MS = 15 * 60_000
/** Clicks that mean someone is on it: no more reminders or escalations until the client writes again. */
const HANDLED_ACTIONS: ReadonlySet<NotificationAction> = new Set(['started', 'closed', 'not_ticket', 'reassigned'])

export const NO_CHANNELS_ERROR = 'Nobody has opened the Shadow chat in Teams yet (and no channels are linked), so no cards were sent.'
export const NO_CONNECTOR_ERROR = 'TEAMS_BOT_APP_ID / TEAMS_BOT_APP_PASSWORD / TEAMS_BOT_TENANT_ID are not set'

export type NotifyDeps = {
  store?: TeamsStore
  reads?: NotifyReads
  /** null means the bot env is not set. */
  connector?: TeamsConnector | null
  siteUrl?: string
  timezone?: string
  teamNumbers?: Set<string>
  /** Role lookup for the stored 1:1 chats (default: lib/teams/identity appUserByEmail). */
  resolveUser?: ResolveUser
}

type PlannedCard = {
  kind: NotificationKind
  /** teams_notifications ref_ids this card claims (one, or one per upload for a files card). */
  refs: string[]
  clientId: string
  clientName: string
  /** One 1:1 chat or channel, or every escalation chat. */
  targets: DeliveryTarget[]
  /** Builds the card from the refs this run managed to claim. */
  build: (claimed: string[]) => AdaptiveCard
  /** Refs whose earlier claim looks lost (no activity id after STALE_CLAIM_MS), with the sent_at seen. */
  stale?: Map<string, string>
}

export type CardOutcome = {
  kind: NotificationKind
  ref: string
  channel: string
  client: string
  status: 'would_send' | 'sent' | 'already_sent' | 'failed' | 'deferred'
  /** A retry of a claim that never got an activity id. */
  retry?: true
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function runTeamsNotifyJob(o: { write: boolean; now: Date }, deps: NotifyDeps = {}): Promise<JobResult> {
  const result: JobResult = { job: JOB, dryRun: !o.write, processed: 0, written: 0, errors: [] }
  const connector = 'connector' in deps ? (deps.connector ?? null) : defaultConnector()
  if (o.write && !connector) {
    result.errors.push(NO_CONNECTOR_ERROR)
    result.fatal = true
    return result
  }
  const store = deps.store ?? supabaseTeamsStore()
  const reads = deps.reads ?? supabaseNotifyReads(createAdminSupabase())
  const site = deps.siteUrl ?? defaultSiteUrl()
  const tz = deps.timezone ?? appTimezone()
  const nowMs = o.now.getTime()
  const iso = (ms: number) => new Date(ms).toISOString()

  const clients = await reads.pilotClients()
  if (!clients.length) {
    result.details = { clients: 0, cards: [] }
    return result
  }
  const clientIds = clients.map((c) => c.clientId)
  // Non-fatal notes (a read hit its row limit). In details, not errors, so the cron does not answer 500.
  const warnings: string[] = []
  const warn = (line: string) => {
    warnings.push(line)
  }
  const [fresh, waiting, uploads] = await Promise.all([
    reads.newTickets(clients, {
      createdSince: iso(nowMs - NEW_WINDOW_MS),
      openedSince: iso(nowMs - OPENED_WINDOW_MS),
      warn,
    }),
    reads.waitingTickets(clients, { lastMessageSince: iso(nowMs - WAITING_WINDOW_MS), warn }),
    reads.newUploads(clientIds, { uploadedSince: iso(nowMs - NEW_WINDOW_MS), warn }),
  ])
  const warningsDetail = () => (warnings.length ? { warnings } : {})
  result.processed = fresh.length + waiting.length + uploads.length
  const found = { newTickets: fresh.length, waitingTickets: waiting.length, uploads: uploads.length }
  // Nothing new and nothing waiting: skip the role lookups (they cost a few reads per stored chat).
  if (result.processed === 0) {
    result.details = { clients: clients.length, found, cards: [], ...warningsDetail() }
    return result
  }

  const routes = await loadRoutes({ store, resolveUser: deps.resolveUser ?? appUserByEmail })
  for (const s of routes.skipped) warn(`Teams 1:1 chat skipped: ${s}`)
  if (!routes.any) {
    // Not an error: until someone opens Shadow every 5-minute run would otherwise show as a failure (500).
    result.details = { clients: clients.length, found, cards: [], note: NO_CHANNELS_ERROR, ...warningsDetail() }
    return result
  }

  // Routing: the accountant's own 1:1 chat (or linked channel), else the escalation chats with one error line per
  // accountant who has not opened Shadow yet.
  const unlinked = new Map<string, { name: string; count: number }>()
  const held: string[] = []
  const routeToAccountant = (vaId: string | null, vaName: string | null, client: string): DeliveryTarget[] | 'held' => {
    const own = routes.accountant(vaId)
    if (own) return [own]
    // A role lookup failed: the missing route may be this accountant's own chat. Wait for the next run (no claim).
    if (vaId && routes.lookupFailed) {
      held.push(`${vaName ?? vaId}: ${client}`)
      return 'held'
    }
    const key = vaId ?? `(no accountant) ${client}`
    const entry = unlinked.get(key) ?? { name: vaId ? `${vaName ?? vaId} (${vaId})` : `no accountant for ${client}`, count: 0 }
    entry.count++
    unlinked.set(key, entry)
    return routes.escalations()
  }
  const unroutable: string[] = []

  const plan: PlannedCard[] = []
  const rows = rowReader(store)

  // 1. New tickets.
  const sentTickets = await store.sentRefs('ticket', fresh.map((t) => t.id))
  const staleTickets = await staleRefs(rows, 'ticket', [...sentTickets], nowMs)
  for (const t of fresh) {
    if (sentTickets.has(t.id) && !staleTickets.has(t.id)) continue
    const targets = routeToAccountant(t.vaId, t.vaName, t.clientName)
    if (targets === 'held') continue // a role lookup failed: this card waits for the next run
    if (!targets.length) {
      unroutable.push(`ticket ${t.id} (${t.clientName})`)
      continue
    }
    plan.push({
      kind: 'ticket',
      refs: [t.id],
      clientId: t.clientId,
      clientName: t.clientName,
      targets,
      // To the accountant's own chat or channel: Open in Shadow only. A fallback to the Admins keeps the buttons.
      build: () => ticketCard(t, { siteUrl: site, readOnly: !!routes.accountant(t.vaId) }),
      stale: pick(staleTickets, t.id),
    })
  }

  // 2. Client messages waiting on a reply (business minutes, Mon to Sat 10:00 to 19:00). A team reply the council has
  // not read yet (it runs every 15 minutes) also holds the reminder; see NotifyReads.repliedTickets.
  const overdue = waiting
    .map((t) => ({ t, minutes: businessMinutesBetween(new Date(t.lastMessageAt), o.now, tz), ref: waitRef(t) }))
    .filter((w) => w.minutes >= REMIND_AFTER_MINUTES)
  const answered = overdue.length ? await reads.repliedTickets(overdue.map((w) => w.t)) : new Set<string>()
  const due = overdue.filter((w) => !answered.has(w.t.id))
  const refs = due.map((w) => w.ref)
  const [sentReminders, sentEscalations] = await Promise.all([
    store.sentRefs('reminder', refs),
    store.sentRefs('escalation', refs),
  ])
  const escalationDue = new Set(due.filter((w) => w.minutes >= ESCALATE_AFTER_MINUTES).map((w) => w.ref))
  const [staleReminders, staleEscalations] = await Promise.all([
    staleRefs(rows, 'reminder', [...sentReminders], nowMs),
    staleRefs(rows, 'escalation', [...sentEscalations].filter((r) => escalationDue.has(r)), nowMs),
  ])
  let accountants: { vaId: string; name: string }[] | null = null
  for (const w of due) {
    const needReminder = !sentReminders.has(w.ref) || staleReminders.has(w.ref)
    const needEscalation = escalationDue.has(w.ref) && (!sentEscalations.has(w.ref) || staleEscalations.has(w.ref))
    if (!needReminder && !needEscalation) continue
    if (await handledSince(rows, w.t, w.ref)) continue
    const waitingMinutes = Math.floor(w.minutes)
    if (needEscalation) {
      const escalationTargets = routes.escalations()
      if (!escalationTargets.length) {
        unroutable.push(`escalation ${w.ref} (${w.t.clientName}): no Admin or Engineer has opened Shadow, and no Escalations channel`)
      } else {
        accountants ??= (await store.accountants()).map((a) => ({ vaId: a.vaId, name: a.name }))
        const list = accountants
        plan.push({
          kind: 'escalation',
          refs: [w.ref],
          clientId: w.t.clientId,
          clientName: w.t.clientName,
          targets: escalationTargets,
          build: () => escalationCard(w.t, { siteUrl: site, waitingMinutes, ref: w.ref, accountants: list }),
          stale: pick(staleEscalations, w.ref),
        })
      }
    }
    if (needReminder) {
      const targets = routeToAccountant(w.t.vaId, w.t.vaName, w.t.clientName)
      if (targets === 'held') {
        // A role lookup failed: this card waits for the next run.
      } else if (!targets.length) {
        unroutable.push(`reminder ${w.ref} (${w.t.clientName})`)
      } else {
        plan.push({
          kind: 'reminder',
          refs: [w.ref],
          clientId: w.t.clientId,
          clientName: w.t.clientName,
          targets,
          build: () => reminderCard(w.t, { siteUrl: site, waitingMinutes, ref: w.ref, readOnly: !!routes.accountant(w.t.vaId) }),
          stale: pick(staleReminders, w.ref),
        })
      }
    }
  }

  // 3. New client files, one card per client (files our team sent into the group are left out).
  const team = deps.teamNumbers ?? (await getTeamNumbers())
  const clientFiles = uploads.filter((u) => isClientFile({ sender_phone: u.senderPhone }, team))
  const sentFiles = await store.sentRefs('files', clientFiles.map((u) => u.uploadId))
  const byClient = new Map<string, UploadForNotify[]>()
  for (const u of clientFiles) {
    if (sentFiles.has(u.uploadId)) continue
    const list = byClient.get(u.clientId) ?? []
    list.push(u)
    byClient.set(u.clientId, list)
  }
  const clientById = new Map<string, PilotClient>(clients.map((c) => [c.clientId, c]))
  for (const [clientId, files] of byClient) {
    const client = clientById.get(clientId)
    const clientName = client?.clientName ?? files[0].clientName
    const targets = routeToAccountant(client?.vaId ?? null, null, clientName)
    if (targets === 'held') continue // a role lookup failed: this card waits for the next run
    if (!targets.length) {
      unroutable.push(`files for ${clientName}`)
      continue
    }
    plan.push({
      kind: 'files',
      refs: files.map((f) => f.uploadId),
      clientId,
      clientName,
      targets,
      build: (claimed) =>
        filesCard({
          clientId,
          clientName,
          siteUrl: site,
          files: files
            .filter((f) => claimed.includes(f.uploadId))
            .map((f) => ({ id: f.uploadId, name: f.fileName ?? 'Unnamed file', at: f.uploadedAt, caption: f.caption })),
        }),
    })
  }

  for (const [, u] of unlinked) {
    result.errors.push(`Accountant ${u.name} has not opened Shadow in Teams: ${u.count} card(s) sent to the escalation chats instead.`)
  }
  if (unroutable.length) {
    result.errors.push(`Nowhere to send in Teams (the person must open the Shadow chat once): ${unroutable.join('; ')}`)
  }

  // 4. Send, at most MAX_SENDS_PER_RUN cards.
  const cards: CardOutcome[] = []
  const deferred: CardOutcome[] = []
  let attempts = 0
  for (const p of plan) {
    const outcome: CardOutcome = {
      kind: p.kind,
      ref: p.refs.join(','),
      channel: p.targets.map((t) => t.name ?? t.id).join(', '),
      client: p.clientName,
      status: 'would_send',
    }
    if (p.stale) outcome.retry = true
    if (attempts >= MAX_SENDS_PER_RUN) {
      outcome.status = 'deferred'
      deferred.push(outcome)
      continue
    }
    if (!o.write) {
      attempts++
      cards.push(outcome)
      continue
    }
    outcome.status = await sendOne(p, store, connector!, result.errors, nowMs, () => attempts++)
    if (outcome.status === 'sent') result.written++
    cards.push(outcome)
  }

  result.details = {
    clients: clients.length,
    found,
    cards,
    deferred: deferred.length ? { count: deferred.length, cards: deferred } : undefined,
    ...(held.length ? { held: { reason: 'a Teams role lookup failed; retried next run', cards: held } } : {}),
    ...warningsDetail(),
  }
  return result
}

/** One reminder / escalation per client message: the ref changes when the client writes again. */
function waitRef(t: TicketForCard): string {
  return `${t.id}@${new Date(t.lastMessageAt).toISOString()}`
}

type RowReader = (kind: NotificationKind, ref: string) => Promise<NotificationRow | null>

/** store.get, read once per (kind, ref) per run. */
function rowReader(store: TeamsStore): RowReader {
  const cache = new Map<string, Promise<NotificationRow | null>>()
  return (kind, ref) => {
    const key = `${kind}:${ref}`
    let row = cache.get(key)
    if (!row) {
      row = store.get(kind, ref)
      cache.set(key, row)
    }
    return row
  }
}

function isStale(row: NotificationRow | null, nowMs: number): row is NotificationRow {
  if (!row || row.activity_id !== null || row.action !== null) return false
  const sent = new Date(row.sent_at).getTime()
  return Number.isFinite(sent) && nowMs - sent >= STALE_CLAIM_MS
}

/**
 * Of these already claimed refs, the ones whose claim looks lost: no activity id and no click STALE_CLAIM_MS
 * after sent_at (the run died between claim and send). Maps ref to the sent_at seen, so sendOne can check that
 * no other run re-claimed it before releasing it.
 */
async function staleRefs(rows: RowReader, kind: NotificationKind, refs: string[], nowMs: number): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const CHUNK = 10
  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK)
    const found = await Promise.all(slice.map((ref) => rows(kind, ref)))
    found.forEach((row, j) => {
      if (isStale(row, nowMs)) out.set(slice[j], row.sent_at)
    })
  }
  return out
}

function pick(stale: Map<string, string>, ref: string): Map<string, string> | undefined {
  const sentAt = stale.get(ref)
  return sentAt === undefined ? undefined : new Map([[ref, sentAt]])
}

/**
 * True when someone already acted after the client's last message, on the ticket card or on this waiting
 * period's reminder or escalation card: started, closed, not a ticket or reassigned (a ping does not count).
 * A later client message (newer last_message_at, so a new ref) re-arms reminders and escalations.
 */
async function handledSince(rows: RowReader, t: TicketForCard, ref: string): Promise<boolean> {
  if (t.status !== 'open') return true
  const last = new Date(t.lastMessageAt).getTime()
  const found = await Promise.all([rows('ticket', t.id), rows('reminder', ref), rows('escalation', ref)])
  return found.some(
    (row) => !!row?.action && !!row.action_at && HANDLED_ACTIONS.has(row.action) && new Date(row.action_at).getTime() >= last,
  )
}

/**
 * Posts one card to every target (one 1:1 chat or channel, or every escalation chat). One claim row per ref covers
 * all copies: its channel_id and activity_id are those of the first copy that went out (the copy the bot refreshes
 * after a click; other copies keep their buttons, and a second click on them is refused as already done). When no
 * copy went out the claims are released so the next run retries; when some did, the failures are reported only.
 */
export async function sendToTargets(
  o: { kind: NotificationKind; refs: string[]; clientId: string; label: string; targets: DeliveryTarget[]; card: (claimed: string[]) => AdaptiveCard },
  store: TeamsStore,
  connector: TeamsConnector,
  errors: string[],
  countAttempt: () => void,
): Promise<'sent' | 'already_sent' | 'failed'> {
  const claimed: string[] = []
  try {
    for (const ref of o.refs) {
      if (await store.claim({ kind: o.kind, ref_id: ref, client_id: o.clientId, channel_id: o.targets[0].id })) claimed.push(ref)
    }
    if (!claimed.length) return 'already_sent'
    countAttempt()
    const activity = cardAttachment(o.card(claimed))
    let first: { target: DeliveryTarget; id: string } | null = null
    const failures: string[] = []
    for (const target of o.targets) {
      try {
        const sent = await connector.send(target.serviceUrl, target.id, activity)
        first ??= { target, id: sent.id }
      } catch (e) {
        failures.push(o.targets.length > 1 ? `${target.name ?? target.id}: ${message(e)}` : message(e))
      }
    }
    // Nothing went out: one error line, and the claims are released below.
    if (!first) throw new Error(failures.join('; '))
    for (const f of failures) errors.push(`${o.kind} ${o.refs.join(',')} (${o.label}) copy to ${f}`)
    // A card is out: keep the claims even if saving the activity id fails, so it is never sent twice.
    // The claim named the first target; when that copy failed, point the row at the chat that has the card.
    const moveTo = first.target.id === o.targets[0].id ? undefined : first.target.id
    for (const ref of claimed) {
      // Tried twice: a row left without an activity id looks like a lost send and would be posted again to everyone.
      try {
        await store.setActivityId(o.kind, ref, first.id, moveTo)
      } catch {
        try {
          await store.setActivityId(o.kind, ref, first.id, moveTo)
        } catch (e) {
          errors.push(`save activity id ${o.kind} ${ref}: ${message(e)}`)
        }
      }
    }
    return 'sent'
  } catch (e) {
    errors.push(`${o.kind} ${o.refs.join(',')} (${o.label}): ${message(e)}`)
    for (const ref of claimed) {
      try {
        await store.release(o.kind, ref)
      } catch (r) {
        errors.push(`release ${o.kind} ${ref}: ${message(r)}`)
      }
    }
    return 'failed'
  }
}

async function sendOne(
  p: PlannedCard,
  store: TeamsStore,
  connector: TeamsConnector,
  errors: string[],
  nowMs: number,
  countAttempt: () => void,
): Promise<CardOutcome['status']> {
  try {
    // A lost claim is released first, but only after a fresh read shows the same stale row (no other run
    // re-claimed it since). The claim then decides, as usual, which run sends it.
    for (const [ref, sentAt] of p.stale ?? []) {
      const row = await store.get(p.kind, ref)
      if (isStale(row, nowMs) && row.sent_at === sentAt) await store.release(p.kind, ref)
    }
  } catch (e) {
    errors.push(`${p.kind} ${p.refs.join(',')} (${p.clientName}): ${message(e)}`)
    return 'failed'
  }
  return sendToTargets(
    { kind: p.kind, refs: p.refs, clientId: p.clientId, label: p.clientName, targets: p.targets, card: p.build },
    store,
    connector,
    errors,
    countAttempt,
  )
}
