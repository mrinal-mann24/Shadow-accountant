// Shared contract for follow-ups: the promise tracker, the document chase list and the repeat-ask alarm.
// Every module codes against these types. Table: public.follow_ups (supabase/applied/2026-11-18-follow-ups.sql).
//
// Flow (cron /api/jobs/follow-ups, every 15 min, write only when jobsWriteEnabled('follow-ups')):
//   1. scan   new client_messages (by created_at) and document_uploads (by uploaded_at, re-read with a 48 h overlap
//             because va-bot's catch-up logs old files with their WhatsApp time) of pilot clients (council_enabled,
//             active), from COUNCIL_START_DATE. State: settings key 'follow_ups_scan', FollowUpScanState below.
//   2. detect a cheap keyword prefilter (prefilter.ts), then one model call (extract.ts):
//             team message  -> promises (with due date) and document requests
//             client message -> repeat ask of something still unanswered
//   3. resolve open or missed items: a later team message or team file delivers a promise; a later client file or
//             message delivers a document request; a later team reply that is not an acknowledgement or a holding
//             reply answers a repeat ask. "Later" means after the source message time, by message time.
//   4. alert  (Teams, lib/teams), only 10:00 to 19:00 IST Monday to Saturday: promise due today -> reminder;
//             promise past due -> missed (at any hour) + escalation; document open 2+ business days -> chase
//             reminder (max 3, every 2 business days), then escalation after the same rest; repeat ask -> escalation.
//             Never alert for items created from history (older than 24 h): the job sets escalated_at on them, with
//             no card, so they are not read for alerts again.

export const FOLLOW_UP_KINDS = ['promise', 'document', 'repeat_ask'] as const
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number]

export const FOLLOW_UP_STATUSES = ['open', 'done', 'missed', 'cancelled'] as const
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number]

/** One row of public.follow_ups. */
export type FollowUpRow = {
  id: string
  client_id: string
  conversation_id: string | null
  kind: FollowUpKind
  source_message_id: string
  item: string
  due_at: string | null
  status: FollowUpStatus
  resolved_at: string | null
  resolved_by: string | null
  resolved_message_id: string | null
  resolved_upload_id: string | null
  reminder_count: number
  last_reminded_at: string | null
  escalated_at: string | null
  created_at: string
}

export type NewFollowUp = Pick<FollowUpRow, 'client_id' | 'conversation_id' | 'kind' | 'source_message_id' | 'item' | 'due_at'>

// ---------------------------------------------------------------- extract.ts (AI)

/** A message as the extractor sees it (credentials already masked). */
export type ScanMessage = {
  message_id: string
  client_id: string
  conversation_id: string | null
  body: string
  direction: 'incoming' | 'outgoing' // effective direction (lib/team effectiveDirection)
  sender_name: string | null
  message_timestamp: string // ISO
}

/** What the model returns for one team (outgoing) message. */
export type TeamExtraction = {
  promises: { item: string; due_date: string | null; due_time: string | null }[] // due_date YYYY-MM-DD (IST) or null
  document_requests: { item: string }[]
}

/** What the model returns for one client (incoming) message. */
export type ClientExtraction = {
  repeat_ask: { item: string; repeats_message_id: string | null } | null
}

/** Delivery check: which open items does this later message or file satisfy. */
export type DeliveryCheck = { delivered_ids: string[] }

export interface FollowUpAI {
  team(msg: ScanMessage, context: ScanMessage[], today: string): Promise<TeamExtraction>
  client(msg: ScanMessage, context: ScanMessage[], open: OpenItem[]): Promise<ClientExtraction>
  /** `evidence` is a message body or a file name (+ caption). Returns ids from `open` it delivers, or []. */
  delivered(evidence: { kind: 'message' | 'file'; text: string; at: string }, open: OpenItem[]): Promise<DeliveryCheck>
}

export type OpenItem = { id: string; kind: FollowUpKind; item: string; created_at: string }

// ---------------------------------------------------------------- store.ts (service role, jobs only)

/** Scan state of one client, kept in the settings JSON (FollowUpScanState). */
export type ClientScanState = {
  /** created_at of the last client_messages row scanned. */
  messages?: string
  /** uploaded_at of the last document_uploads row scanned (the next read re-reads 48 h before it). */
  uploads?: string
  /** Uploads already checked, upload_id -> uploaded_at, so the overlap never repeats a model call. Bounded. */
  seenUploads?: Record<string, string>
  /** Runs in a row an item failed, by 'message:<id>' or 'upload:<id>'. Cleared when it succeeds or is skipped. */
  failures?: Record<string, number>
}

/** settings 'follow_ups_scan'. Version 1 (old) was { [clientId]: ISO } for messages and files together. */
export type FollowUpScanState = { version: 2; clients: Record<string, ClientScanState> }

/** Note (no error) when the table is not there yet: the job answers 200 and does nothing. */
export const TABLE_MISSING_NOTE = 'The follow_ups table is not created yet (supabase/applied/2026-11-18-follow-ups.sql).'

/** Thrown by the store when Postgres says relation follow_ups does not exist (42P01). */
export class FollowUpsTableMissingError extends Error {
  readonly code = '42P01'
  constructor() {
    super(TABLE_MISSING_NOTE)
    this.name = 'FollowUpsTableMissingError'
  }
}

export function isTableMissing(e: unknown): boolean {
  return e instanceof FollowUpsTableMissingError || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '42P01')
}

export interface FollowUpStore {
  pilotClients(): Promise<{ client_id: string; client_name: string; va_id: string | null }[]>
  watermark(): Promise<FollowUpScanState>
  saveWatermark(w: FollowUpScanState): Promise<void>
  /** Messages of one client with created_at > after (oldest first), message_timestamp >= since, up to limit. */
  newMessages(clientId: string, after: string | null, since: string | null, limit: number): Promise<(ScanMessage & { created_at: string; sender_phone: string | null })[]>
  /** The n messages before `at` in this client's chat (any direction), oldest first. Context only. */
  contextBefore(clientId: string, at: string, n: number): Promise<ScanMessage[]>
  /** Client files with after < uploaded_at (<= until when given), oldest first (team files included; caller filters by sender). */
  newUploads(
    clientId: string,
    after: string | null,
    limit: number,
    until?: string,
  ): Promise<{ upload_id: string; file_name: string; uploaded_at: string; sender_phone: string | null }[]>
  /** Open and missed items of one client, with the source message time (null when the message is gone). */
  open(clientId: string): Promise<(FollowUpRow & { source_at: string | null })[]>
  /** Inserts; ignores (returns null for) a duplicate (source_message_id, kind, item). */
  insert(row: NewFollowUp): Promise<FollowUpRow | null>
  resolve(id: string, patch: { status: FollowUpStatus; resolved_by: string; resolved_message_id?: string | null; resolved_upload_id?: string | null; at: string }): Promise<void>
  markReminded(id: string, at: string): Promise<void>
  markEscalated(id: string, at: string): Promise<void>
  /**
   * Items that may need an alert or a status change now, with the source message time: open promises due by
   * dueBefore, missed promises not escalated, open documents due by dueBefore and not escalated, open repeat asks not
   * escalated. An item is "history" (never alerted) when created_at - source_at > 24 h, i.e. it was found while
   * scanning old messages (the pilot's 30-day backfill).
   */
  alertCandidates(dueBefore: string): Promise<(FollowUpRow & { source_at: string })[]>
  get(id: string): Promise<FollowUpRow | null>
  extend(id: string, newDue: string): Promise<void>
}

// ---------------------------------------------------------------- Teams (lib/teams/cards.ts, lib/teams/bot.ts)

export type FollowUpAction = 'done' | 'cancel' | 'extend'

/** data of the follow-up card buttons (Action.Execute verb 'followup'). kind/ref = the teams_notifications row. */
export type FollowUpCardData = { action: FollowUpAction; followUpId: string; kind: 'reminder' | 'escalation'; ref: string }

/** teams_notifications.ref_id for follow-up cards (kind 'reminder' or 'escalation'), so they never clash with tickets. */
export const followUpRef = (id: string, what: 'due' | 'missed' | 'chase' | 'repeat', n = 0): string => `fu:${id}:${what}:${n}`

/**
 * Alert cycle of a follow-up: days since 1970 of its current due date (0 when it has none). An extend changes
 * due_at, so the cards after it get new refs (teams_notifications claims are per ref).
 */
export const followUpCycle = (dueAt: string | null): number => {
  const t = dueAt ? Date.parse(dueAt) : NaN
  return Number.isNaN(t) ? 0 : Math.floor(t / 86_400_000)
}

/** A follow-up with what a card or the client page needs. */
export type FollowUpView = {
  id: string
  clientId: string
  clientName: string
  kind: FollowUpKind
  item: string
  status: FollowUpStatus
  dueAt: string | null
  createdAt: string
  sourceAt: string // message time of the source message
  sourceSender: string | null
  vaId: string | null
  vaName: string | null
  conversationId: string | null
  reminderCount: number
  resolvedAt: string | null
  resolvedBy: string | null
}
