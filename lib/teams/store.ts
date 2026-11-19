import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { maskCredentials, maskNullable } from '@/lib/ai/redact'
import { chunk } from '@/lib/data/paginate'
import type { Database } from '@/lib/db/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type {
  NotificationAction,
  NotificationKind,
  NotificationRow,
  PersonalChats,
  TeamsChannelMap,
  TeamsChannelRef,
  TeamsStore,
  TicketForCard,
} from './types'

// TeamsStore over Supabase (service role, server only): the channel map in settings ('teams_channels') and the
// teams_notifications table. No user scoping here: the bot and the notify job check access before calling.

export const CHANNELS_KEY = 'teams_channels'
const CHANNELS_NOTE = 'Shadow Teams bot channel map'
export const PERSONAL_KEY = 'teams_personal'
const PERSONAL_NOTE = 'Shadow Teams bot: 1:1 chat of each person, by login email'
const TABLE = 'teams_notifications'
const NOTIFICATION_COLS = 'kind, ref_id, client_id, channel_id, activity_id, sent_at, action, action_by, action_at'
const KINDS: readonly string[] = ['ticket', 'reminder', 'escalation', 'files']
const ACTIONS: readonly string[] = ['started', 'closed', 'not_ticket', 'reassigned', 'pinged']

type Db = SupabaseClient<Database>

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function channelRef(v: unknown): TeamsChannelRef | null {
  if (!isObject(v)) return null
  const id = str(v.id)
  return id ? { id, name: str(v.name) } : null
}

/** Parses the settings value. null when it is not valid JSON or misses serviceUrl / tenantId. */
export function parseChannelMap(value: string | null | undefined): TeamsChannelMap | null {
  if (!value) return null
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  const serviceUrl = str(raw.serviceUrl)
  const tenantId = str(raw.tenantId)
  if (!serviceUrl || !tenantId) return null
  const accountants: Record<string, TeamsChannelRef> = {}
  if (isObject(raw.accountants)) {
    for (const [vaId, ref] of Object.entries(raw.accountants)) {
      const r = channelRef(ref)
      if (r) accountants[vaId] = r
    }
  }
  return { serviceUrl, tenantId, teamId: str(raw.teamId), accountants, escalations: channelRef(raw.escalations) }
}

/** Parses settings 'teams_personal'. Bad JSON or bad entries are dropped ({} when nothing is valid). */
export function parsePersonalChats(value: string | null | undefined): PersonalChats {
  if (!value) return {}
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return {}
  }
  if (!isObject(raw)) return {}
  const out: PersonalChats = {}
  for (const [email, v] of Object.entries(raw)) {
    if (!isObject(v)) continue
    const conversationId = str(v.conversationId)
    const serviceUrl = str(v.serviceUrl)
    const key = email.trim().toLowerCase()
    if (!key || !conversationId || !serviceUrl) continue
    out[key] = { conversationId, serviceUrl, name: str(v.name), at: str(v.at) ?? '' }
  }
  return out
}

function toNotificationRow(r: Database['public']['Tables']['teams_notifications']['Row']): NotificationRow {
  return {
    kind: (KINDS.includes(r.kind) ? r.kind : 'ticket') as NotificationKind,
    ref_id: r.ref_id,
    client_id: r.client_id,
    channel_id: r.channel_id,
    activity_id: r.activity_id,
    sent_at: r.sent_at,
    action: r.action && ACTIONS.includes(r.action) ? (r.action as NotificationAction) : null,
    action_by: r.action_by,
    action_at: r.action_at,
  }
}

/** vas.status values that count as a current accountant. Lenient: null / blank counts as active. */
export function isActiveVa(status: string | null | undefined): boolean {
  const s = (status ?? '').trim().toLowerCase()
  return s === '' || s === 'active'
}

export function supabaseTeamsStore(db?: SupabaseClient<Database>): TeamsStore {
  const conn = (): Db => db ?? createAdminSupabase()

  return {
    async channels() {
      const { data, error } = await conn().from('settings').select('value').eq('key', CHANNELS_KEY).maybeSingle()
      if (error) throw new Error(`teams channels: ${error.message}`)
      return parseChannelMap(data?.value)
    },

    async saveChannels(map) {
      const value = JSON.stringify(map)
      const d = conn()
      const found = await d.from('settings').select('key').eq('key', CHANNELS_KEY).maybeSingle()
      if (found.error) throw new Error(`teams saveChannels: ${found.error.message}`)
      const res = found.data
        ? await d.from('settings').update({ value }).eq('key', CHANNELS_KEY)
        : await d.from('settings').insert({ key: CHANNELS_KEY, value, note: CHANNELS_NOTE })
      if (res.error) throw new Error(`teams saveChannels: ${res.error.message}`)
    },

    async personalChats() {
      const { data, error } = await conn().from('settings').select('value').eq('key', PERSONAL_KEY).maybeSingle()
      if (error) throw new Error(`teams personalChats: ${error.message}`)
      return parsePersonalChats(data?.value)
    },

    async savePersonalChat(email, chat) {
      const key = email.trim().toLowerCase()
      if (!key) return
      const d = conn()
      // Read, change one entry, write. Two people registering at the same moment can overwrite each other's entry;
      // the bot reads the chat back after saving and writes it again when it is missing (lib/teams/bot.ts).
      const found = await d.from('settings').select('value').eq('key', PERSONAL_KEY).maybeSingle()
      if (found.error) throw new Error(`teams savePersonalChat: ${found.error.message}`)
      const chats = parsePersonalChats(found.data?.value)
      chats[key] = chat
      const value = JSON.stringify(chats)
      const res = found.data
        ? await d.from('settings').update({ value }).eq('key', PERSONAL_KEY)
        : await d.from('settings').insert({ key: PERSONAL_KEY, value, note: PERSONAL_NOTE })
      if (res.error) throw new Error(`teams savePersonalChat: ${res.error.message}`)
    },

    async sentRefs(kind, refIds) {
      const out = new Set<string>()
      const ids = [...new Set(refIds.filter(Boolean))]
      for (const part of chunk(ids, 200)) {
        const { data, error } = await conn().from(TABLE).select('ref_id').eq('kind', kind).in('ref_id', part)
        if (error) throw new Error(`teams sentRefs: ${error.message}`)
        for (const r of data ?? []) out.add(r.ref_id)
      }
      return out
    },

    async claim(row) {
      const { error } = await conn().from(TABLE).insert({
        kind: row.kind,
        ref_id: row.ref_id,
        client_id: row.client_id,
        channel_id: row.channel_id,
      })
      if (!error) return true
      if (error.code === '23505') return false
      throw new Error(`teams claim: ${error.message}`)
    },

    async release(kind, refId) {
      const { error } = await conn().from(TABLE).delete().eq('kind', kind).eq('ref_id', refId)
      if (error) throw new Error(`teams release: ${error.message}`)
    },

    async setActivityId(kind, refId, activityId, channelId) {
      const patch = channelId ? { activity_id: activityId, channel_id: channelId } : { activity_id: activityId }
      const { error } = await conn().from(TABLE).update(patch).eq('kind', kind).eq('ref_id', refId)
      if (error) throw new Error(`teams setActivityId: ${error.message}`)
    },

    async get(kind, refId) {
      const { data, error } = await conn()
        .from(TABLE)
        .select(NOTIFICATION_COLS)
        .eq('kind', kind)
        .eq('ref_id', refId)
        .maybeSingle()
      if (error) throw new Error(`teams get: ${error.message}`)
      return data ? toNotificationRow(data as Database['public']['Tables']['teams_notifications']['Row']) : null
    },

    async recordAction(kind, refId, action, by, at) {
      // An update that matches no row changes nothing, which is what we want when the card row is missing.
      const { error } = await conn()
        .from(TABLE)
        .update({ action, action_by: by, action_at: at })
        .eq('kind', kind)
        .eq('ref_id', refId)
      if (error) throw new Error(`teams recordAction: ${error.message}`)
    },

    async ticketForCard(ticketId) {
      if (!ticketId) return null
      const d = conn()
      const { data: t, error } = await d
        .from('conversations')
        .select('id, client_id, va_id, title, summary, tag, status, opened_at, last_message_at, last_message_direction, sla_breached')
        .eq('id', ticketId)
        .maybeSingle()
      if (error) {
        if (error.code === '22P02') return null
        throw new Error(`teams ticketForCard: ${error.message}`)
      }
      if (!t) return null
      const c = await d.from('clients').select('client_name, va_id').eq('client_id', t.client_id).maybeSingle()
      if (c.error) throw new Error(`teams ticketForCard: client: ${c.error.message}`)
      const vaId = t.va_id ?? c.data?.va_id ?? null
      let vaName: string | null = null
      if (vaId) {
        const v = await d.from('vas').select('va_name').eq('va_id', vaId).maybeSingle()
        if (v.error) throw new Error(`teams ticketForCard: accountant: ${v.error.message}`)
        vaName = v.data?.va_name ?? null
      }
      const card: TicketForCard = {
        id: t.id,
        clientId: t.client_id,
        clientName: c.data?.client_name ?? 'Unknown client',
        title: maskNullable(t.title),
        summary: maskCredentials(t.summary),
        tag: t.tag,
        status: t.status,
        openedAt: t.opened_at,
        lastMessageAt: t.last_message_at,
        lastMessageDirection: t.last_message_direction,
        vaId,
        vaName,
        slaBreached: t.sla_breached,
      }
      return card
    },

    async accountants() {
      const { data, error } = await conn().from('vas').select('va_id, va_name, email, status, teams_user_id').order('va_name')
      if (error) throw new Error(`teams accountants: ${error.message}`)
      return (data ?? [])
        .filter((v) => isActiveVa(v.status))
        .sort((a, b) => a.va_name.localeCompare(b.va_name))
        .map((v) => ({ vaId: v.va_id, name: v.va_name, email: v.email, teamsUserId: v.teams_user_id }))
    },
  }
}
