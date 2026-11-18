import 'server-only'
import { maskNullable } from '@/lib/ai/redact'
import type { AppUser } from '@/lib/auth/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getTeamNumbers } from '@/lib/team'
import { DOCUMENT_COLS, MEETING_COLS, isClientFile, toDocumentItem, toMeetingItem } from './documents'
import { MESSAGE_COLS, clampLimit, toMessageItem } from './messages'
import { chunk } from './paginate'
import { canAccessClient, scopedClientIds, type Db } from './scope'
import type { ActivityItem, DocumentItem, MeetingItem, MessageItem, TimelineItem } from './types'

const DETAIL_MAX = 500
const TICKET_COLS = 'id, client_id, title, summary, status, tag, opened_at, closed_at'

type TicketRow = {
  id: string
  client_id: string
  title: string | null
  summary: string
  status: string
  tag: string | null
  opened_at: string
  closed_at: string | null
}

function clip(s: string | null | undefined, max = DETAIL_MAX): string | null {
  s = maskNullable(s) // never show a credential value on screen
  if (!s) return null
  const t = s.trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

export function messageToTimeline(m: MessageItem, clientId: string): TimelineItem {
  return {
    kind: 'message',
    id: m.id,
    at: m.at,
    clientId,
    title: m.senderName ?? (m.direction === 'outgoing' ? 'Team' : 'Client'),
    detail: clip(m.body),
    direction: m.direction,
    link: null,
  }
}

export function documentToTimeline(d: DocumentItem, clientId: string): TimelineItem | null {
  if (!d.uploadedAt) return null
  return {
    kind: 'document',
    id: d.id,
    at: d.uploadedAt,
    clientId,
    title: d.fileName ?? 'File',
    detail: d.folderName,
    link: d.url,
  }
}

export function meetingToTimeline(m: MeetingItem, clientId: string): TimelineItem | null {
  const at = m.start ?? m.date
  if (!at) return null
  return { kind: 'meeting', id: m.id, at, clientId, title: m.subject ?? 'Meeting', detail: m.pocName, link: m.link }
}

export function ticketToTimeline(t: TicketRow, event: 'opened' | 'closed' = 'opened'): TimelineItem {
  const at = event === 'closed' && t.closed_at ? t.closed_at : t.opened_at
  const name = maskNullable(t.title) ?? clip(t.summary, 80) ?? 'Ticket'
  return {
    kind: 'ticket',
    id: t.id,
    at,
    clientId: t.client_id,
    title: event === 'closed' ? `Closed: ${name}` : name,
    detail: clip(t.summary),
    link: null,
  }
}

/** Newest first; ties keep a stable order by kind and id. */
export function sortTimeline<T extends TimelineItem>(items: T[]): T[] {
  return items.sort((a, b) => {
    const t = Date.parse(b.at) - Date.parse(a.at)
    if (t !== 0) return t
    return a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)
  })
}

/** Messages, files, meetings and tickets for one client, newest first (default 100, max 500). */
/** clientOnly: only messages and files the client sent (no outgoing team messages or files); tickets and meetings stay. */
export async function getTimeline(
  user: AppUser,
  clientId: string,
  o: { limit?: number; clientOnly?: boolean } = {},
): Promise<TimelineItem[]> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, clientId))) return []
  const limit = clampLimit(o.limit, 100, 500)

  const [team, msgs, docs, meetings, tickets] = await Promise.all([
    getTeamNumbers(),
    (o.clientOnly
      ? db.from('client_messages').select(MESSAGE_COLS).eq('client_id', clientId).eq('direction', 'incoming')
      : db.from('client_messages').select(MESSAGE_COLS).eq('client_id', clientId)
    )
      .order('message_timestamp', { ascending: false })
      .order('message_id', { ascending: false })
      .limit(limit),
    db
      .from('document_uploads')
      .select(DOCUMENT_COLS)
      .eq('client_id', clientId)
      .order('uploaded_at', { ascending: false, nullsFirst: false })
      .limit(limit),
    db
      .from('va_meeting_transcripts')
      .select(MEETING_COLS)
      .eq('client_id', clientId)
      .order('meeting_start', { ascending: false, nullsFirst: false })
      .limit(limit),
    db.from('conversations').select(TICKET_COLS).eq('client_id', clientId).order('opened_at', { ascending: false }).limit(limit),
  ])
  for (const [name, res] of [
    ['messages', msgs],
    ['documents', docs],
    ['meetings', meetings],
    ['tickets', tickets],
  ] as const) {
    if (res.error) throw new Error(`getTimeline: ${name}: ${res.error.message}`)
  }

  const items: TimelineItem[] = [
    ...(msgs.data ?? []).map((r) => messageToTimeline(toMessageItem(r, team), clientId)),
    ...(docs.data ?? [])
      .filter((r) => !o.clientOnly || isClientFile(r, team))
      .map((r) => documentToTimeline(toDocumentItem(r), clientId)),
    ...(meetings.data ?? []).map((r) => meetingToTimeline(toMeetingItem(r), clientId)),
    ...(tickets.data ?? []).map((r) => ticketToTimeline(r)),
  ].filter((i): i is TimelineItem => i !== null)
  return sortTimeline(items).slice(0, limit)
}

async function namesFor(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const part of chunk([...new Set(ids)])) {
    const { data, error } = await db.from('clients').select('client_id, client_name').in('client_id', part)
    if (error) throw new Error(`listRecentActivity: clients: ${error.message}`)
    for (const c of data ?? []) out.set(c.client_id, c.client_name)
  }
  return out
}

/**
 * "Today" feed across the user's clients: messages, files, meetings, tickets opened and closed in the last
 * `sinceHours` (default 24, max 168), newest first, at most `limit` items (default 50, max 200).
 * clientOnly: only messages and files the client sent (no outgoing team messages or files); tickets and meetings stay.
 */
export async function listRecentActivity(
  user: AppUser,
  o: { sinceHours?: number; limit?: number; clientOnly?: boolean } = {},
): Promise<ActivityItem[]> {
  const db = createAdminSupabase()
  const ids = await scopedClientIds(db, user)
  if (ids && ids.length === 0) return []
  const limit = clampLimit(o.limit, 50, 200)
  const hours = clampLimit(o.sinceHours, 24, 168)
  const since = new Date(Date.now() - hours * 3_600_000).toISOString()
  const parts: (string[] | null)[] = ids === null ? [null] : chunk(ids)
  const team = await getTeamNumbers()

  const items: TimelineItem[] = []
  for (const part of parts) {
    let msgQ = db.from('client_messages').select(MESSAGE_COLS).gte('message_timestamp', since)
    if (o.clientOnly) msgQ = msgQ.eq('direction', 'incoming')
    let docQ = db.from('document_uploads').select(DOCUMENT_COLS).gte('uploaded_at', since)
    let meetQ = db.from('va_meeting_transcripts').select(MEETING_COLS).gte('meeting_start', since)
    let openQ = db.from('conversations').select(TICKET_COLS).gte('opened_at', since)
    let closeQ = db.from('conversations').select(TICKET_COLS).gte('closed_at', since)
    if (part) {
      msgQ = msgQ.in('client_id', part)
      docQ = docQ.in('client_id', part)
      meetQ = meetQ.in('client_id', part)
      openQ = openQ.in('client_id', part)
      closeQ = closeQ.in('client_id', part)
    }
    const [msgs, docs, meetings, opened, closed] = await Promise.all([
      msgQ.order('message_timestamp', { ascending: false }).limit(limit),
      docQ.order('uploaded_at', { ascending: false }).limit(limit),
      meetQ.order('meeting_start', { ascending: false }).limit(limit),
      openQ.order('opened_at', { ascending: false }).limit(limit),
      closeQ.order('closed_at', { ascending: false }).limit(limit),
    ])
    for (const [name, res] of [
      ['messages', msgs],
      ['documents', docs],
      ['meetings', meetings],
      ['opened tickets', opened],
      ['closed tickets', closed],
    ] as const) {
      if (res.error) throw new Error(`listRecentActivity: ${name}: ${res.error.message}`)
    }
    for (const r of msgs.data ?? []) if (r.client_id) items.push(messageToTimeline(toMessageItem(r, team), r.client_id))
    for (const r of docs.data ?? []) {
      if (o.clientOnly && !isClientFile(r, team)) continue
      const item = r.client_id ? documentToTimeline(toDocumentItem(r), r.client_id) : null
      if (item) items.push(item)
    }
    for (const r of meetings.data ?? []) {
      const item = r.client_id ? meetingToTimeline(toMeetingItem(r), r.client_id) : null
      if (item) items.push(item)
    }
    for (const r of opened.data ?? []) items.push(ticketToTimeline(r, 'opened'))
    for (const r of closed.data ?? []) items.push(ticketToTimeline(r, 'closed'))
  }

  const top = sortTimeline(items).slice(0, limit)
  const names = await namesFor(
    db,
    top.map((i) => i.clientId),
  )
  return top.map((i) => ({ ...i, clientName: names.get(i.clientId) ?? null }))
}
