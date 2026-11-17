import { parseSlaMinutes } from '@/lib/scoring'
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Insert, Update } from '@/lib/db/types'
import { isActiveClient } from '@/lib/data/client-status'

// Every database read and write the council job makes, in one place. The job talks to this
// interface so it can be tested with an in-memory fake.

export type CouncilClient = { client_id: string; client_name: string; va_id: string | null; whatsapp_group_id: string | null }

export type PendingMessage = {
  message_id: string
  client_id: string
  body: string
  direction: string | null
  sender_phone: string | null
  sender_name: string | null
  message_timestamp: string
  whatsapp_group_id: string | null
}

export type StoredConversation = {
  id: string
  title: string | null
  summary: string
  last_message_at: string
  message_count: number
  closed_at: string | null
}

export type LogRow = { attempts: number; max_attempts: number; status: string }

/** The stored outcome of an earlier vote, enough to finish applying it after a partial failure. */
export type StoredVerdict = { final_decision: string; final_conv_id: string | null }

/** Current state of one ticket, read before re-applying a stored decision. */
export type TicketState = StoredConversation & { status: string }

export type SlaCandidate = { id: string; client_id: string; last_message_at: string }

/** A message's direction fields, for the effective direction (lib/team). */
export type DirectionFields = { direction: string | null; sender_phone: string | null }

export interface CouncilStore {
  councilClients(clientIds?: string[]): Promise<CouncilClient[]>
  /** processed_at is null, oldest first (message_timestamp, then message_id), one page from offset. */
  pendingMessages(clientIds: string[], limit: number, offset: number): Promise<PendingMessage[]>
  /** Stored verdicts by message_id, for messages that already have one. */
  existingVerdicts(messageIds: string[]): Promise<Map<string, StoredVerdict>>
  processingLog(messageIds: string[]): Promise<Map<string, LogRow>>
  /** Up to n messages before msg in the same group (or client when no group), oldest first. */
  recentMessages(msg: PendingMessage, n: number): Promise<PendingMessage[]>
  conversations(clientId: string, closedSince: string): Promise<{ open: StoredConversation[]; recentlyClosed: StoredConversation[] }>
  /** settings key 'sla_minutes'; null when unset or not a number. */
  slaMinutes(): Promise<number | null>
  insertVerdict(row: Insert<'council_verdicts'>): Promise<string>
  /** null when the ticket does not exist. */
  getConversation(id: string): Promise<TicketState | null>
  /** Id of a council ticket for this client opened at exactly this time (left by a run that failed). */
  findCouncilTicket(clientId: string, openedAt: string): Promise<string | null>
  createConversation(row: Insert<'conversations'>): Promise<string>
  updateConversation(id: string, patch: Update<'conversations'>): Promise<void>
  markMessage(messageId: string, conversationId: string | null, processedAt: string): Promise<void>
  upsertLog(row: Insert<'message_processing_log'>): Promise<void>
  /** Open, not yet breached, last message incoming and older than `before`. */
  slaCandidates(clientIds: string[], before: string): Promise<SlaCandidate[]>
  /** The client's messages with after < message_timestamp <= until (any processing state), up to 200. */
  messagesBetween(clientId: string, after: string, until: string): Promise<DirectionFields[]>
  markSlaBreached(ids: string[]): Promise<void>
}

const MESSAGE_COLUMNS =
  'message_id, client_id, body, direction, sender_phone, sender_name, message_timestamp, whatsapp_group_id'
const CONVERSATION_COLUMNS = 'id, title, summary, last_message_at, message_count, closed_at'

function fail(where: string, error: { message: string } | null): void {
  if (error) throw new Error(`council ${where}: ${error.message}`)
}

export function supabaseCouncilStore(db: SupabaseClient<Database>): CouncilStore {
  return {
    async councilClients(clientIds) {
      let q = db
        .from('clients')
        .select('client_id, client_name, va_id, whatsapp_group_id, status')
        .eq('council_enabled', true)
      if (clientIds?.length) q = q.in('client_id', clientIds)
      const { data, error } = await q
      fail('clients', error)
      // Inactive clients (churned or parked in HubSpot) are skipped even when the council is on for them.
      return (data ?? [])
        .filter((c) => isActiveClient(c.status))
        .map(({ client_id, client_name, va_id, whatsapp_group_id }) => ({ client_id, client_name, va_id, whatsapp_group_id }))
    },

    async pendingMessages(clientIds, limit, offset) {
      const { data, error } = await db
        .from('client_messages')
        .select(MESSAGE_COLUMNS)
        .is('processed_at', null)
        .in('client_id', clientIds)
        .order('message_timestamp', { ascending: true })
        .order('message_id', { ascending: true })
        .range(offset, offset + limit - 1)
      fail('pending messages', error)
      return (data ?? []).filter((m): m is PendingMessage => m.client_id !== null)
    },

    async existingVerdicts(messageIds) {
      const out = new Map<string, StoredVerdict>()
      if (!messageIds.length) return out
      const { data, error } = await db
        .from('council_verdicts')
        .select('message_id, final_decision, final_conv_id')
        .in('message_id', messageIds)
      fail('existing verdicts', error)
      for (const v of data ?? []) out.set(v.message_id, { final_decision: v.final_decision, final_conv_id: v.final_conv_id })
      return out
    },

    async processingLog(messageIds) {
      const out = new Map<string, LogRow>()
      if (!messageIds.length) return out
      const { data, error } = await db
        .from('message_processing_log')
        .select('message_id, attempts, max_attempts, status')
        .in('message_id', messageIds)
      fail('processing log', error)
      for (const r of data ?? []) out.set(r.message_id, { attempts: r.attempts, max_attempts: r.max_attempts, status: r.status })
      return out
    },

    async recentMessages(msg, n) {
      let q = db
        .from('client_messages')
        .select(MESSAGE_COLUMNS)
        .lte('message_timestamp', msg.message_timestamp)
        .neq('message_id', msg.message_id)
      q = msg.whatsapp_group_id ? q.eq('whatsapp_group_id', msg.whatsapp_group_id) : q.eq('client_id', msg.client_id)
      const { data, error } = await q.order('message_timestamp', { ascending: false }).limit(n)
      fail('recent messages', error)
      return (data ?? [])
        .map((m) => ({ ...m, client_id: m.client_id ?? msg.client_id }))
        .reverse()
    },

    async conversations(clientId, closedSince) {
      const [open, closed] = await Promise.all([
        db
          .from('conversations')
          .select(CONVERSATION_COLUMNS)
          .eq('client_id', clientId)
          .eq('status', 'open')
          .order('last_message_at', { ascending: false })
          .limit(30),
        db
          .from('conversations')
          .select(CONVERSATION_COLUMNS)
          .eq('client_id', clientId)
          .eq('status', 'closed')
          .gte('closed_at', closedSince)
          .order('closed_at', { ascending: false })
          .limit(30),
      ])
      fail('open conversations', open.error)
      fail('closed conversations', closed.error)
      return { open: open.data ?? [], recentlyClosed: closed.data ?? [] }
    },

    async slaMinutes() {
      const { data, error } = await db.from('settings').select('value').eq('key', 'sla_minutes').maybeSingle()
      fail('settings sla_minutes', error)
      return parseSlaMinutes(data?.value)
    },

    async insertVerdict(row) {
      const { data, error } = await db.from('council_verdicts').insert(row).select('id').single()
      fail('insert verdict', error)
      return data!.id
    },

    async getConversation(id) {
      const { data, error } = await db.from('conversations').select('id, title, summary, last_message_at, message_count, closed_at, status').eq('id', id).maybeSingle()
      fail('get conversation', error)
      return data ?? null
    },

    async findCouncilTicket(clientId, openedAt) {
      const { data, error } = await db
        .from('conversations')
        .select('id')
        .eq('client_id', clientId)
        .eq('opened_by', 'council')
        .eq('opened_at', openedAt)
        .order('id')
        .limit(1)
      fail('find council ticket', error)
      return data?.[0]?.id ?? null
    },

    async createConversation(row) {
      const { data, error } = await db.from('conversations').insert(row).select('id').single()
      fail('create conversation', error)
      return data!.id
    },

    async updateConversation(id, patch) {
      const { error } = await db.from('conversations').update(patch).eq('id', id)
      fail('update conversation', error)
    },

    async markMessage(messageId, conversationId, processedAt) {
      const { error } = await db
        .from('client_messages')
        .update({ conversation_id: conversationId, processed_at: processedAt })
        .eq('message_id', messageId)
      fail('mark message', error)
    },

    async upsertLog(row) {
      const { error } = await db.from('message_processing_log').upsert(row, { onConflict: 'message_id' })
      fail('processing log upsert', error)
    },

    async slaCandidates(clientIds, before) {
      if (!clientIds.length) return []
      const { data, error } = await db
        .from('conversations')
        .select('id, client_id, last_message_at')
        .in('client_id', clientIds)
        .eq('status', 'open')
        .eq('sla_breached', false)
        .eq('last_message_direction', 'incoming')
        .lt('last_message_at', before)
        .order('id')
        .limit(1000)
      fail('sla candidates', error)
      return data ?? []
    },

    async messagesBetween(clientId, after, until) {
      const { data, error } = await db
        .from('client_messages')
        .select('direction, sender_phone')
        .eq('client_id', clientId)
        .gt('message_timestamp', after)
        .lte('message_timestamp', until)
        .order('message_timestamp', { ascending: true })
        .limit(200)
      fail('messages between', error)
      return data ?? []
    },

    async markSlaBreached(ids) {
      if (!ids.length) return
      const { error } = await db.from('conversations').update({ sla_breached: true }).in('id', ids)
      fail('mark sla breached', error)
    },
  }
}
