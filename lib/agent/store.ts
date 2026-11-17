import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminSupabase } from '@/lib/supabase/admin'

// Raw reads (and the one embedding write) for the context agent, behind small interfaces so tools and the
// embed job are tested with in-memory fakes. Callers pass client ids that are already scoped by AppUser
// (lib/agent/scope.ts); null means "every client" and is only used for users who see all clients.

export type MessageHit = {
  message_id: string
  client_id: string | null
  message_timestamp: string
  body: string
  sender_name: string | null
  sender_phone: string | null
  direction: string | null
}

export type MeetingWithTranscript = {
  id: string
  client_id: string | null
  subject: string | null
  meeting_start: string | null
  meeting_date: string | null
  teams_url: string | null
  transcript: string | null
}

export interface AgentStore {
  /** Full text on client_messages.body_tsv with websearch_to_tsquery, newest first. */
  searchMessagesText(query: string, clientIds: string[] | null, limit: number): Promise<MessageHit[]>
  /** Messages in scope that have an embedding. */
  countEmbedded(clientIds: string[] | null): Promise<number>
  /** Nearest messages by embedding (needs the proposed SQL function; see VECTOR_SEARCH_APPROVED). */
  searchMessagesVector(embedding: number[], clientIds: string[] | null, limit: number): Promise<MessageHit[]>
  /** Meetings of one client with transcript text, newest first. */
  meetingsWithTranscript(clientId: string, limit: number): Promise<MeetingWithTranscript[]>
}

/**
 * Vector search needs the SQL function in supabase/proposals/match-client-messages.sql, which is NOT applied.
 * Flip to true only after it is approved and applied. Until then search is full text only.
 */
// Approved 17 Nov 2026; public.match_client_messages applied (supabase/proposals/match-client-messages.sql).
export const VECTOR_SEARCH_APPROVED = true

const HIT_COLS = 'message_id, client_id, message_timestamp, body, sender_name, sender_phone, direction'
const IN_CHUNK = 150

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

function newestFirst(rows: MessageHit[], limit: number): MessageHit[] {
  return [...rows].sort((a, b) => (a.message_timestamp < b.message_timestamp ? 1 : -1)).slice(0, limit)
}

export const supabaseAgentStore: AgentStore = {
  async searchMessagesText(query, clientIds, limit) {
    const db = createAdminSupabase()
    const run = async (ids: string[] | null) => {
      let q = db
        .from('client_messages')
        .select(HIT_COLS)
        .textSearch('body_tsv', query, { type: 'websearch' })
        .not('client_id', 'is', null)
      if (ids) q = q.in('client_id', ids)
      const { data, error } = await q.order('message_timestamp', { ascending: false }).limit(limit)
      if (error) throw new Error(`searchMessagesText: ${error.message}`)
      return (data ?? []) as MessageHit[]
    }
    if (clientIds === null) return run(null)
    if (clientIds.length === 0) return []
    const all: MessageHit[] = []
    for (const part of chunks(clientIds, IN_CHUNK)) all.push(...(await run(part)))
    return newestFirst(all, limit)
  },

  async countEmbedded(clientIds) {
    if (clientIds && clientIds.length === 0) return 0
    const db = createAdminSupabase()
    let total = 0
    for (const part of clientIds ? chunks(clientIds, IN_CHUNK) : [null]) {
      let q = db.from('client_messages').select('message_id', { count: 'exact', head: true }).not('embedding', 'is', null)
      if (part) q = q.in('client_id', part)
      const { count, error } = await q
      if (error) throw new Error(`countEmbedded: ${error.message}`)
      total += count ?? 0
      if (total > 0) return total
    }
    return total
  },

  async searchMessagesVector(embedding, clientIds, limit) {
    if (!VECTOR_SEARCH_APPROVED) return []
    // The function is not in the generated types until it is applied, so call it untyped.
    const db = createAdminSupabase() as unknown as SupabaseClient
    const { data, error } = await db.rpc('match_client_messages', {
      query_embedding: `[${embedding.join(',')}]`,
      client_ids: clientIds,
      match_count: limit,
    })
    if (error) throw new Error(`searchMessagesVector: ${error.message}`)
    return (data ?? []) as MessageHit[]
  },

  async meetingsWithTranscript(clientId, limit) {
    const db = createAdminSupabase()
    const { data, error } = await db
      .from('va_meeting_transcripts')
      .select('id, client_id, subject, meeting_start, meeting_date, teams_url, transcript')
      .eq('client_id', clientId)
      .order('meeting_start', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (error) throw new Error(`meetingsWithTranscript: ${error.message}`)
    return data ?? []
  },
}

// ---- embed job store ----

export interface EmbedStore {
  /** Messages with text and no embedding yet. */
  countPending(): Promise<number>
  /** Up to `limit` of those, newest first (recent messages matter most for chat). */
  fetchPending(limit: number): Promise<{ message_id: string; body: string }[]>
  /** Writes one embedding; only if the row still has none (safe to re-run). */
  saveEmbedding(messageId: string, vector: string): Promise<void>
}

export const supabaseEmbedStore: EmbedStore = {
  async countPending() {
    const db = createAdminSupabase()
    const { count, error } = await db
      .from('client_messages')
      .select('message_id', { count: 'exact', head: true })
      .is('embedding', null)
      .neq('body', '')
    if (error) throw new Error(`countPending: ${error.message}`)
    return count ?? 0
  },
  async fetchPending(limit) {
    const db = createAdminSupabase()
    const { data, error } = await db
      .from('client_messages')
      .select('message_id, body')
      .is('embedding', null)
      .neq('body', '')
      .order('message_timestamp', { ascending: false })
      .order('message_id')
      .limit(limit)
    if (error) throw new Error(`fetchPending: ${error.message}`)
    return data ?? []
  },
  async saveEmbedding(messageId, vector) {
    const db = createAdminSupabase()
    const { error } = await db
      .from('client_messages')
      .update({ embedding: vector })
      .eq('message_id', messageId)
      .is('embedding', null)
    if (error) throw new Error(`saveEmbedding ${messageId}: ${error.message}`)
  },
}
