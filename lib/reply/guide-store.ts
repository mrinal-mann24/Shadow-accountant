import 'server-only'
// Every database read and write the style-guides job makes (service role), scoped to the pilot client ids it is given.
// The job talks to this interface so it can be tested with an in-memory fake.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/db/types'
import { MESSAGE_COLS } from '@/lib/data/messages'
import { fetchAll } from '@/lib/data/paginate'
import { readCorrections } from '@/lib/data/reply-suggestions'
import type { Correction } from './chat-text'
import { guideSettingKey, parsePilotClients, parseStoredGuide, PILOT_SETTING_KEY, serializeGuide, type StoredGuide } from './style-guide'

type MessageRow = Pick<
  Database['public']['Tables']['client_messages']['Row'],
  'message_id' | 'dedup_hash' | 'message_timestamp' | 'body' | 'sender_name' | 'sender_phone' | 'direction' | 'message_type' | 'conversation_id'
>

export interface GuideStore {
  pilotClients(): Promise<string[]>
  clientNames(ids: string[]): Promise<Map<string, string>>
  guide(clientId: string): Promise<StoredGuide | null>
  /** The client's latest `limit` messages, oldest first. */
  messages(clientId: string, limit: number): Promise<MessageRow[]>
  corrections(clientId: string, limit: number): Promise<Correction[]>
  saveGuide(clientId: string, clientName: string, guide: StoredGuide): Promise<void>
}

function fail(where: string, error: { message: string } | null): void {
  if (error) throw new Error(`style-guides ${where}: ${error.message}`)
}

export function supabaseGuideStore(db: SupabaseClient<Database>): GuideStore {
  return {
    async pilotClients() {
      const { data, error } = await db.from('settings').select('value').eq('key', PILOT_SETTING_KEY).maybeSingle()
      fail('pilot clients', error)
      return parsePilotClients(data?.value)
    },

    async clientNames(ids) {
      const out = new Map<string, string>()
      if (!ids.length) return out
      const { data, error } = await db.from('clients').select('client_id, client_name').in('client_id', ids)
      fail('clients', error)
      for (const c of data ?? []) out.set(c.client_id, c.client_name)
      return out
    },

    async guide(clientId) {
      const { data, error } = await db.from('settings').select('value').eq('key', guideSettingKey(clientId)).maybeSingle()
      fail('guide', error)
      return parseStoredGuide(data?.value)
    },

    async messages(clientId, limit) {
      // PostgREST returns at most 1000 rows a request: page through (newest first), then put oldest first.
      const rows = await fetchAll(
        'style-guides messages',
        (from, to) =>
          db
            .from('client_messages')
            .select(MESSAGE_COLS)
            .eq('client_id', clientId)
            .order('message_timestamp', { ascending: false })
            .order('message_id', { ascending: false })
            .range(from, to),
        { maxRows: limit },
      )
      return rows.reverse()
    },

    corrections(clientId, limit) {
      return readCorrections(db, clientId, limit)
    },

    async saveGuide(clientId, clientName, guide) {
      const { error } = await db
        .from('settings')
        .upsert(
          { key: guideSettingKey(clientId), value: serializeGuide(guide), note: `Suggested reply style guide: ${clientName}` },
          { onConflict: 'key' },
        )
      fail('save guide', error)
    },
  }
}
