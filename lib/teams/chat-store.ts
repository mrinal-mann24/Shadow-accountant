import 'server-only'
import type { Json } from '@/lib/db/database.types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { ChatRow, PendingMeta, PendingSave, TeamsChatStore } from './chat'

// TeamsChatStore over Supabase (service role, server only): table teams_chat. Every read and delete is filtered by
// the person's email (lower case), so one person can never load or take another person's turns or pending saves.

const TABLE = 'teams_chat'

const key = (email: string) => email.trim().toLowerCase()

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** PendingMeta from the stored JSON, or null when it is not valid. */
export function parsePendingMeta(v: unknown): PendingMeta | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const clientId = str(o.clientId)
  const clientName = str(o.clientName)
  const title = str(o.title)
  if (!clientId || !clientName || !title) return null
  return { clientId, clientName, title, meetingDate: str(o.meetingDate) }
}

function toPending(r: { id: string; user_email: string; content: string; meta: unknown; created_at: string }): PendingSave | null {
  const meta = parsePendingMeta(r.meta)
  return meta ? { id: r.id, email: r.user_email, content: r.content, meta, createdAt: r.created_at } : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const supabaseTeamsChatStore: TeamsChatStore = {
  async recentTurns(email, since, limit) {
    const { data, error } = await createAdminSupabase()
      .from(TABLE)
      .select('kind, content, created_at')
      .eq('user_email', key(email))
      .in('kind', ['user', 'assistant'])
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(`teams_chat recentTurns: ${error.message}`)
    return (data ?? [])
      .filter((r): r is ChatRow => r.kind === 'user' || r.kind === 'assistant')
      .reverse()
  },

  async addTurns(email, turns) {
    if (turns.length === 0) return
    // Strictly increasing times, so rows inserted together never tie and always read back in order.
    const base = Date.now()
    const rows = turns.map((t, i) => ({
      user_email: key(email),
      kind: t.kind,
      content: t.content.slice(0, 40000),
      created_at: new Date(base + i).toISOString(),
    }))
    const { error } = await createAdminSupabase().from(TABLE).insert(rows)
    if (error) throw new Error(`teams_chat addTurns: ${error.message}`)
  },

  async clear(email) {
    const { error } = await createAdminSupabase().from(TABLE).delete().eq('user_email', key(email)).in('kind', ['user', 'assistant'])
    if (error) throw new Error(`teams_chat clear: ${error.message}`)
  },

  async addPending(email, content, meta) {
    const { data, error } = await createAdminSupabase()
      .from(TABLE)
      .insert({ user_email: key(email), kind: 'pending_save', content: content.slice(0, 40000), meta: meta as unknown as Json })
      .select('id')
      .single()
    if (error || !data) throw new Error(`teams_chat addPending: ${error?.message ?? 'no row'}`)
    return data.id
  },

  async getPending(id, email) {
    if (!UUID.test(id)) return null
    const { data, error } = await createAdminSupabase()
      .from(TABLE)
      .select('id, user_email, content, meta, created_at')
      .eq('id', id)
      .eq('user_email', key(email))
      .eq('kind', 'pending_save')
      .maybeSingle()
    if (error) throw new Error(`teams_chat getPending: ${error.message}`)
    return data ? toPending(data) : null
  },

  async takePending(id, email) {
    if (!UUID.test(id)) return null
    // Delete ... returning: only one of two clicks gets the row.
    const { data, error } = await createAdminSupabase()
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('user_email', key(email))
      .eq('kind', 'pending_save')
      .select('id, user_email, content, meta, created_at')
    if (error) throw new Error(`teams_chat takePending: ${error.message}`)
    const row = data?.[0]
    return row ? toPending(row) : null
  },

  async prune(before) {
    const { data, error } = await createAdminSupabase().from(TABLE).delete().lt('created_at', before).select('id')
    if (error) throw new Error(`teams_chat prune: ${error.message}`)
    return data?.length ?? 0
  },
}
