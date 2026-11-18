import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { maskCredentials } from '@/lib/ai/redact'
import { isActiveClient } from '@/lib/data/client-status'
import { chunk, fetchAll } from '@/lib/data/paginate'
import type { Database } from '@/lib/db/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { effectiveDirection, getTeamNumbers, loadTeamNumbers } from '@/lib/team'
import {
  FollowUpsTableMissingError,
  type ClientScanState,
  type FollowUpRow,
  type FollowUpScanState,
  type FollowUpStore,
  type FollowUpView,
  type ScanMessage,
} from './types'

// FollowUpStore over Supabase (service role, server only). No user scoping here: the follow-ups job works on
// pilot clients, and lib/data/followups.ts checks the user before it calls followUpRows / viewsForRows.

export const WATERMARK_KEY = 'follow_ups_scan'
const WATERMARK_NOTE = 'Follow-ups scan watermark'
const TABLE = 'follow_ups'
export const FOLLOW_UP_COLS =
  'id, client_id, conversation_id, kind, source_message_id, item, due_at, status, resolved_at, resolved_by, resolved_message_id, resolved_upload_id, reminder_count, last_reminded_at, escalated_at, created_at'
const MESSAGE_COLS =
  'message_id, client_id, conversation_id, body, direction, sender_name, sender_phone, message_timestamp, created_at'
const UNRESOLVED = ['open', 'missed']

type Db = SupabaseClient<Database>
type DbRow = Database['public']['Tables']['follow_ups']['Row']
type MessageRow = Pick<
  Database['public']['Tables']['client_messages']['Row'],
  'message_id' | 'client_id' | 'conversation_id' | 'body' | 'direction' | 'sender_name' | 'sender_phone' | 'message_timestamp' | 'created_at'
>

const TABLE_MISSING = '42P01'

function fail(where: string, error: { message: string; code?: string } | null): void {
  if (!error) return
  if (error.code === TABLE_MISSING) throw new FollowUpsTableMissingError()
  throw new Error(`follow-ups ${where}: ${error.message}`)
}

/** For fetchAll pages: keeps the 42P01 signal that fetchAll's own error message would drop. */
function guardPage<T extends { error: { message: string; code?: string } | null }>(r: T): T {
  if (r.error?.code === TABLE_MISSING) throw new FollowUpsTableMissingError()
  return r
}

/** The table's check constraints guarantee kind and status; this only narrows the type. */
export function toFollowUpRow(r: DbRow): FollowUpRow {
  return { ...r, kind: r.kind as FollowUpRow['kind'], status: r.status as FollowUpRow['status'] }
}

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function isoMap(raw: unknown): Record<string, string> | undefined {
  if (!isObject(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) if (isIso(v)) out[k] = v
  return Object.keys(out).length ? out : undefined
}

function countMap(raw: unknown): Record<string, number> | undefined {
  if (!isObject(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v
  return Object.keys(out).length ? out : undefined
}

function clientState(raw: unknown): ClientScanState | null {
  if (!isObject(raw)) return null
  const s: ClientScanState = {}
  if (isIso(raw.messages)) s.messages = raw.messages
  if (isIso(raw.uploads)) s.uploads = raw.uploads
  const seen = isoMap(raw.seenUploads)
  if (seen) s.seenUploads = seen
  const failures = countMap(raw.failures)
  if (failures) s.failures = failures
  return s
}

/**
 * Parses the scan state setting. Version 2: { version: 2, clients: { [clientId]: ClientScanState } }. Version 1
 * (old): { [clientId]: ISO }, one watermark for messages and files; it becomes both watermarks (files are re-read
 * with the overlap anyway). Anything malformed becomes an empty state or is dropped.
 */
export function parseWatermark(value: string | null | undefined): FollowUpScanState {
  const out: FollowUpScanState = { version: 2, clients: {} }
  if (!value) return out
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return out
  }
  if (!isObject(raw)) return out
  if (raw.version === 2) {
    if (!isObject(raw.clients)) return out
    for (const [k, v] of Object.entries(raw.clients)) {
      const s = clientState(v)
      if (s) out.clients[k] = s
    }
    return out
  }
  if ('version' in raw) return out // a version this code does not know: start clean rather than guess
  for (const [k, v] of Object.entries(raw)) if (isIso(v)) out.clients[k] = { messages: v, uploads: v }
  return out
}

function toScanMessage(m: MessageRow, clientId: string, team: Set<string>): ScanMessage {
  return {
    message_id: m.message_id,
    client_id: m.client_id ?? clientId,
    conversation_id: m.conversation_id,
    body: maskCredentials(m.body),
    direction: effectiveDirection(m, team),
    sender_name: m.sender_name,
    message_timestamp: m.message_timestamp,
  }
}

/** Source message time and sender by message_id. */
async function sourceMessages(db: Db, ids: string[]): Promise<Map<string, { at: string; sender: string | null }>> {
  const out = new Map<string, { at: string; sender: string | null }>()
  for (const part of chunk([...new Set(ids)])) {
    const { data, error } = await db
      .from('client_messages')
      .select('message_id, message_timestamp, sender_name')
      .in('message_id', part)
    fail('source messages', error)
    for (const m of data ?? []) out.set(m.message_id, { at: m.message_timestamp, sender: m.sender_name })
  }
  return out
}

/**
 * Views for rows already read (and, for screens, already scoped). Keeps the order of `rows`.
 * vaId: the ticket's accountant when the follow-up has a ticket with one, else the client's.
 */
export async function viewsForRows(db: Db, rows: FollowUpRow[]): Promise<FollowUpView[]> {
  if (rows.length === 0) return []
  const clients = new Map<string, { name: string; vaId: string | null }>()
  for (const part of chunk([...new Set(rows.map((r) => r.client_id))])) {
    const { data, error } = await db.from('clients').select('client_id, client_name, va_id').in('client_id', part)
    fail('view clients', error)
    for (const c of data ?? []) clients.set(c.client_id, { name: c.client_name, vaId: c.va_id })
  }
  const convVa = new Map<string, string | null>()
  const convIds = [...new Set(rows.map((r) => r.conversation_id).filter((id): id is string => !!id))]
  for (const part of chunk(convIds)) {
    const { data, error } = await db.from('conversations').select('id, va_id').in('id', part)
    fail('view tickets', error)
    for (const c of data ?? []) convVa.set(c.id, c.va_id)
  }
  const vaIdOf = (r: FollowUpRow) =>
    (r.conversation_id ? convVa.get(r.conversation_id) : null) ?? clients.get(r.client_id)?.vaId ?? null
  const vaNames = new Map<string, string>()
  const vaIds = [...new Set(rows.map(vaIdOf).filter((id): id is string => !!id))]
  for (const part of chunk(vaIds)) {
    const { data, error } = await db.from('vas').select('va_id, va_name').in('va_id', part)
    fail('view accountants', error)
    for (const v of data ?? []) vaNames.set(v.va_id, v.va_name)
  }
  const sources = await sourceMessages(
    db,
    rows.map((r) => r.source_message_id),
  )

  return rows.map((r) => {
    const vaId = vaIdOf(r)
    const src = sources.get(r.source_message_id)
    return {
      id: r.id,
      clientId: r.client_id,
      clientName: clients.get(r.client_id)?.name ?? 'Unknown client',
      kind: r.kind,
      item: maskCredentials(r.item),
      status: r.status,
      dueAt: r.due_at,
      createdAt: r.created_at,
      sourceAt: src?.at ?? r.created_at,
      sourceSender: src?.sender ?? null,
      vaId,
      vaName: vaId ? (vaNames.get(vaId) ?? null) : null,
      conversationId: r.conversation_id,
      reminderCount: r.reminder_count,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
    }
  })
}

/** Follow-ups by id (service role, for Teams cards). Unknown ids are skipped; order follows `ids`. */
export async function followUpViews(ids: string[], db?: Db): Promise<FollowUpView[]> {
  const d = db ?? createAdminSupabase()
  const wanted = [...new Set(ids.filter(Boolean))]
  const byId = new Map<string, FollowUpRow>()
  for (const part of chunk(wanted)) {
    const { data, error } = await d.from(TABLE).select(FOLLOW_UP_COLS).in('id', part)
    if (error && error.code !== '22P02') fail('views', error)
    for (const r of (data ?? []) as DbRow[]) byId.set(r.id, toFollowUpRow(r))
  }
  return viewsForRows(
    d,
    wanted.map((id) => byId.get(id)).filter((r): r is FollowUpRow => !!r),
  )
}

export function supabaseFollowUpStore(db?: Db): FollowUpStore {
  const conn = (): Db => db ?? createAdminSupabase()
  // With an explicit client (tests, or a job that passes one) the team numbers come from that client, once.
  let team: Promise<Set<string>> | null = null
  const teamNumbers = (): Promise<Set<string>> => {
    if (!db) return getTeamNumbers()
    team ??= loadTeamNumbers(db)
    return team
  }

  async function update(where: string, id: string, patch: Database['public']['Tables']['follow_ups']['Update']) {
    const { error } = await conn().from(TABLE).update(patch).eq('id', id)
    fail(where, error)
  }

  return {
    async pilotClients() {
      const { data, error } = await conn()
        .from('clients')
        .select('client_id, client_name, va_id, status')
        .eq('council_enabled', true)
        .order('client_id')
      fail('pilot clients', error)
      return (data ?? [])
        .filter((c) => isActiveClient(c.status))
        .map(({ client_id, client_name, va_id }) => ({ client_id, client_name, va_id }))
    },

    async watermark() {
      const { data, error } = await conn().from('settings').select('value').eq('key', WATERMARK_KEY).maybeSingle()
      fail('watermark', error)
      return parseWatermark(data?.value)
    },

    async saveWatermark(w) {
      const value = JSON.stringify(w)
      const d = conn()
      const found = await d.from('settings').select('key').eq('key', WATERMARK_KEY).maybeSingle()
      fail('saveWatermark', found.error)
      const res = found.data
        ? await d.from('settings').update({ value }).eq('key', WATERMARK_KEY)
        : await d.from('settings').insert({ key: WATERMARK_KEY, value, note: WATERMARK_NOTE })
      fail('saveWatermark', res.error)
    },

    async newMessages(clientId, after, since, limit) {
      let q = conn().from('client_messages').select(MESSAGE_COLS).eq('client_id', clientId)
      if (after) q = q.gt('created_at', after)
      if (since) q = q.gte('message_timestamp', since)
      const { data, error } = await q
        .order('created_at', { ascending: true })
        .order('message_id', { ascending: true })
        .limit(limit)
      fail('new messages', error)
      const nums = await teamNumbers()
      return ((data ?? []) as MessageRow[]).map((m) => ({
        ...toScanMessage(m, clientId, nums),
        created_at: m.created_at ?? m.message_timestamp,
        sender_phone: m.sender_phone,
      }))
    },

    async contextBefore(clientId, at, n) {
      if (n <= 0) return []
      const { data, error } = await conn()
        .from('client_messages')
        .select(MESSAGE_COLS)
        .eq('client_id', clientId)
        .lt('message_timestamp', at)
        .order('message_timestamp', { ascending: false })
        .order('message_id', { ascending: false })
        .limit(n)
      fail('context', error)
      const nums = await teamNumbers()
      return ((data ?? []) as MessageRow[]).reverse().map((m) => toScanMessage(m, clientId, nums))
    },

    async newUploads(clientId, after, limit, until) {
      let q = conn()
        .from('document_uploads')
        .select('upload_id, file_name, uploaded_at, sender_phone')
        .eq('client_id', clientId)
      if (after) q = q.gt('uploaded_at', after)
      if (until) q = q.lte('uploaded_at', until)
      const { data, error } = await q
        .order('uploaded_at', { ascending: true })
        .order('upload_id', { ascending: true })
        .limit(limit)
      fail('new uploads', error)
      return (data ?? [])
        .filter((u): u is typeof u & { uploaded_at: string } => !!u.uploaded_at)
        .map((u) => ({ upload_id: u.upload_id, file_name: u.file_name ?? '', uploaded_at: u.uploaded_at, sender_phone: u.sender_phone }))
    },

    async open(clientId) {
      const rows = await fetchAll('follow-ups open', (from, to) =>
        conn()
          .from(TABLE)
          .select(FOLLOW_UP_COLS)
          .eq('client_id', clientId)
          .in('status', UNRESOLVED)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
          .then(guardPage),
      )
      const out = (rows as DbRow[]).map(toFollowUpRow)
      const sources = await sourceMessages(
        conn(),
        out.map((r) => r.source_message_id),
      )
      return out.map((r) => ({ ...r, source_at: sources.get(r.source_message_id)?.at ?? null }))
    },

    async insert(row) {
      const { data, error } = await conn()
        .from(TABLE)
        .insert({
          client_id: row.client_id,
          conversation_id: row.conversation_id,
          kind: row.kind,
          source_message_id: row.source_message_id,
          item: row.item,
          due_at: row.due_at,
        })
        .select(FOLLOW_UP_COLS)
      if (error?.code === '23505') return null
      fail('insert', error)
      const first = (data ?? [])[0] as DbRow | undefined
      if (!first) throw new Error('follow-ups insert: no row returned')
      return toFollowUpRow(first)
    },

    async resolve(id, patch) {
      // Only an item still open or missed is closed, so a later AI match never overwrites a manual close.
      const { error } = await conn()
        .from(TABLE)
        .update({
          status: patch.status,
          resolved_by: patch.resolved_by,
          resolved_at: patch.at,
          resolved_message_id: patch.resolved_message_id ?? null,
          resolved_upload_id: patch.resolved_upload_id ?? null,
        })
        .eq('id', id)
        .in('status', UNRESOLVED)
      fail('resolve', error)
    },

    async markReminded(id, at) {
      // Read then write: the job is the only writer of reminder_count and runs one at a time.
      const { data, error } = await conn().from(TABLE).select('reminder_count').eq('id', id).maybeSingle()
      fail('markReminded', error)
      if (!data) return
      await update('markReminded', id, { reminder_count: (data.reminder_count ?? 0) + 1, last_reminded_at: at })
    },

    async markEscalated(id, at) {
      await update('markEscalated', id, { escalated_at: at })
    },

    async alertCandidates(dueBefore) {
      const d = conn()
      const base = () => d.from(TABLE).select(FOLLOW_UP_COLS)
      type Q = ReturnType<typeof base>
      const read = (label: string, where: (q: Q) => Q) =>
        fetchAll(label, (from, to) =>
          where(base())
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)
            .then(guardPage),
        )
      // Items whose alerts are over (escalated, history included) are not read again, except open promises past
      // due: they still turn missed.
      const lists = await Promise.all([
        read('follow-ups due promises', (q) => q.eq('kind', 'promise').eq('status', 'open').lte('due_at', dueBefore)),
        read('follow-ups missed promises', (q) => q.eq('kind', 'promise').eq('status', 'missed').is('escalated_at', null)),
        read('follow-ups due documents', (q) => q.eq('kind', 'document').eq('status', 'open').lte('due_at', dueBefore).is('escalated_at', null)),
        read('follow-ups repeat asks', (q) => q.eq('kind', 'repeat_ask').eq('status', 'open').is('escalated_at', null)),
      ])
      const byId = new Map<string, FollowUpRow>()
      for (const r of lists.flat() as DbRow[]) if (!byId.has(r.id)) byId.set(r.id, toFollowUpRow(r))
      const rows = [...byId.values()]
      const sources = await sourceMessages(
        d,
        rows.map((r) => r.source_message_id),
      )
      return rows.map((r) => ({ ...r, source_at: sources.get(r.source_message_id)?.at ?? r.created_at }))
    },

    async get(id) {
      if (!id) return null
      const { data, error } = await conn().from(TABLE).select(FOLLOW_UP_COLS).eq('id', id).maybeSingle()
      if (error?.code === '22P02') return null
      fail('get', error)
      return data ? toFollowUpRow(data as DbRow) : null
    },

    async extend(id, newDue) {
      // A new due date starts a new alert cycle (same reset as lib/data followUpAction 'extend').
      await update('extend', id, { due_at: newDue, status: 'open', escalated_at: null, reminder_count: 0, last_reminded_at: null })
    },
  }
}
