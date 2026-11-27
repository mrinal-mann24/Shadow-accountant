// Pure helpers for the Tickets screen: type counts, grouping by client, row urgency and the reply timeline.
// Client-safe (types only from lib/data). Times are shown in IST like the rest of the app.
import { TAG_LABELS } from '@/components/accountant/ticket-intent'
import { DEFAULT_TIMEZONE, ticketWaitMinutes } from '@/components/accountant/logic'
import { TAGS, type Tag } from '@/lib/council/types'
import type { ConversationItem, MessageItem } from '@/lib/data/types'
import { waitingSide, type WaitingSide } from '@/lib/data/waiting-side'

// ---------------------------------------------------------------- Ticket types strip

/** One line per tag, matching how the ticket council chooses it (lib/council/prompt.ts). */
export const TAG_DEFINITIONS: Record<Tag, string> = {
  escalation: 'Threat to leave, wants a manager, or urgent',
  complaint: 'Unhappy with our service',
  neutral: 'Asks us to do, send or answer something',
  positive: 'Client praised our work',
  suspense: 'Bank entry with no bill or receipt yet',
}

export type TagCount = { tag: Tag; label: string; definition: string; count: number }

/** Open tickets per tag, in TAGS order. Tickets with no tag (or an unknown one) are counted in `untagged`. */
export function countOpenTicketTags(tickets: ConversationItem[]): { counts: TagCount[]; untagged: number } {
  const by = new Map<string, number>()
  let untagged = 0
  for (const t of tickets) {
    if (t.status !== 'open') continue
    if (t.tag && (TAGS as readonly string[]).includes(t.tag)) by.set(t.tag, (by.get(t.tag) ?? 0) + 1)
    else untagged++
  }
  return {
    counts: TAGS.map((tag) => ({ tag, label: TAG_LABELS[tag], definition: TAG_DEFINITIONS[tag], count: by.get(tag) ?? 0 })),
    untagged,
  }
}

// ---------------------------------------------------------------- Grouping by client

export type ClientTicketGroup = {
  clientId: string
  clientName: string | null
  /** Distinct accountants on these tickets, in order of first appearance. */
  vaIds: string[]
  tickets: ConversationItem[]
}

/**
 * Groups tickets by client. Clients with the most tickets come first; ties keep the order in which each
 * client first appears (so the incoming urgency sort decides). Tickets keep their incoming order inside a group.
 */
export function groupTicketsByClient(tickets: ConversationItem[]): ClientTicketGroup[] {
  const groups = new Map<string, ClientTicketGroup>()
  for (const t of tickets) {
    let g = groups.get(t.clientId)
    if (!g) {
      g = { clientId: t.clientId, clientName: t.clientName, vaIds: [], tickets: [] }
      groups.set(t.clientId, g)
    }
    g.tickets.push(t)
    if (t.vaId && !g.vaIds.includes(t.vaId)) g.vaIds.push(t.vaId)
  }
  const list = [...groups.values()]
  const firstSeen = new Map(list.map((g, i) => [g.clientId, i]))
  return list.sort((a, b) => b.tickets.length - a.tickets.length || firstSeen.get(a.clientId)! - firstSeen.get(b.clientId)!)
}

// ---------------------------------------------------------------- Whose turn (waiting side)

export { waitingSide, type WaitingSide }

export const WAITING_SIDES: readonly WaitingSide[] = ['us', 'client']

export const WAITING_SIDE_LABELS: Record<WaitingSide, string> = {
  us: 'Waiting on us',
  client: 'Waiting on client',
}

export function isWaitingSide(v: unknown): v is WaitingSide {
  return v === 'us' || v === 'client'
}

/** Open tickets per side. Closed tickets are not counted. */
export function countBySide(tickets: ConversationItem[]): Record<WaitingSide, number> {
  const out: Record<WaitingSide, number> = { us: 0, client: 0 }
  for (const t of tickets) if (t.status === 'open') out[waitingSide(t)]++
  return out
}

/**
 * The badge on an open ticket row: red "Pending from client" on the client's side, green "We replied" on our side
 * when our team sent the last message. null when the client is waiting on us (the SLA dot and timer show that).
 */
export function sideBadge(t: ConversationItem): { tone: 'client' | 'replied'; label: string } | null {
  if (t.status !== 'open') return null
  if (waitingSide(t) === 'client') return { tone: 'client', label: 'Pending from client' }
  if (t.lastMessageDirection === 'outgoing') return { tone: 'replied', label: 'We replied' }
  return null
}

// ---------------------------------------------------------------- Row urgency

/** Client waits this long (minutes) before a row turns red. Same as the default SLA in lib/scoring. */
export const LONG_WAIT_MINUTES = 60

export type TicketUrgency = 'breached' | 'waiting-long' | 'waiting' | 'replied' | 'closed'

export function ticketUrgency(t: ConversationItem, now: Date): TicketUrgency {
  if (t.status !== 'open') return 'closed'
  if (t.slaBreached) return 'breached'
  const wait = ticketWaitMinutes(t, now)
  if (wait === null) return 'replied'
  return wait >= LONG_WAIT_MINUTES ? 'waiting-long' : 'waiting'
}

/** Plain words for each urgency, used next to the colour so status never relies on colour alone. */
export const URGENCY_LABELS: Record<TicketUrgency, string> = {
  breached: 'SLA breached',
  'waiting-long': 'Client waiting long',
  waiting: 'Client waiting',
  replied: 'Our team replied last',
  closed: 'Closed',
}

/** "Closed automatically" (the ticket council), "Closed by the team" (a person), or "Closed" when unknown. */
export function ticketClosedLabel(t: Pick<ConversationItem, 'closedBy'>): string {
  if (t.closedBy === 'ai') return 'Closed automatically'
  if (t.closedBy === 'person') return 'Closed by the team'
  return 'Closed'
}

/** Masking tokens, not placeholders for the accountant. */
const MASK_TOKENS = new Set(['number', 'hidden'])

/**
 * Placeholders a suggested reply leaves for the accountant to fill, in order and without repeats:
 * "[attach: invoice PDF]", "[amount]". The masking tokens [number] and [hidden] are not placeholders.
 */
export function findPlaceholders(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\[([^\]\n]{2,60})\]/g)) {
    const inner = m[1].trim()
    if (MASK_TOKENS.has(inner.toLowerCase()) || out.includes(m[0])) continue
    out.push(m[0])
  }
  return out
}

/**
 * Show the Suggested reply box: an open ticket where the client is waiting on us (their message is the latest). The
 * client being a pilot client with a style guide is checked on the server.
 */
export function wantsSuggestedReply(t: Pick<ConversationItem, 'status' | 'lastMessageDirection'>): boolean {
  return t.status === 'open' && t.lastMessageDirection === 'incoming'
}

/** Title for a ticket, falling back to the start of the summary. */
export function ticketTitle(t: Pick<ConversationItem, 'title' | 'summary'>): string {
  return t.title ?? (t.summary.slice(0, 80) || 'Untitled ticket')
}

/** "1 h 5 m", "12 m", "3 d": the short age shown on the right of a row. */
export function shortAge(iso: string | null | undefined, now: Date): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const min = Math.max(0, Math.round((now.getTime() - at) / 60_000))
  if (min < 1) return 'now'
  if (min < 60) return `${min} m`
  if (min < 1440) {
    const h = Math.floor(min / 60)
    const m = min % 60
    return m > 0 ? `${h} h ${m} m` : `${h} h`
  }
  return `${Math.floor(min / 1440)} d`
}

// ---------------------------------------------------------------- Selection link

export type TicketParams = { status?: string; tag?: string; q?: string; side?: WaitingSide }

/** The default side tab on open tickets: Waiting on us. */
export const DEFAULT_SIDE: WaitingSide = 'us'

/** /tickets link that keeps the current filters and selects one ticket (?t=). */
export function ticketHref(params: TicketParams, id: string): string {
  const sp = new URLSearchParams()
  if (params.status && params.status !== 'open') sp.set('status', params.status)
  else if (params.side && params.side !== DEFAULT_SIDE) sp.set('side', params.side)
  if (params.tag) sp.set('tag', params.tag)
  if (params.q) sp.set('q', params.q)
  sp.set('t', id)
  return `/tickets?${sp.toString()}`
}

// ---------------------------------------------------------------- Reply timeline

const FILE_RE = /^\s*\[File shared:\s*([^\]]+?)\s*\]\s*([\s\S]*)$/

/** "[File shared: name] caption" from the WhatsApp bot, else null. */
export function parseFileShared(body: string | null | undefined): { fileName: string; caption: string } | null {
  if (!body) return null
  const m = FILE_RE.exec(body)
  if (!m) return null
  return { fileName: m[1], caption: m[2].trim() }
}

export type FirstReply =
  | { kind: 'replied'; minutes: number }
  | { kind: 'waiting'; since: string }
  | { kind: 'none' }

/**
 * How long our team took to answer the first client message on the ticket (messages oldest first,
 * effective direction). 'waiting' when no team message follows it; 'none' when the client never wrote.
 */
export function firstReply(messages: Pick<MessageItem, 'at' | 'direction'>[]): FirstReply {
  const firstIn = messages.find((m) => m.direction === 'incoming')
  if (!firstIn) return { kind: 'none' }
  const inAt = Date.parse(firstIn.at)
  const reply = messages.find((m) => m.direction === 'outgoing' && Date.parse(m.at) >= inAt)
  if (!reply) return { kind: 'waiting', since: firstIn.at }
  return { kind: 'replied', minutes: Math.max(0, Math.round((Date.parse(reply.at) - inAt) / 60_000)) }
}

/** "2:15 pm" in IST. */
export function formatTime(iso: string | null | undefined, timezone: string = DEFAULT_TIMEZONE): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
}

/** "26 Nov" in IST: the day heading in the timeline. */
export function formatDay(iso: string | null | undefined, timezone: string = DEFAULT_TIMEZONE): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: 'numeric', month: 'short' }).format(d)
}

export type TimelineEvent = {
  id: string
  at: string
  time: string
  /** Set on the first event of each IST day. */
  day: string | null
  who: 'client' | 'team'
  senderName: string | null
  file: { fileName: string; caption: string } | null
  text: string
}

/** Ticket messages (oldest first) as timeline events with IST time, side and file details. */
export function buildTimeline(messages: MessageItem[], timezone: string = DEFAULT_TIMEZONE): TimelineEvent[] {
  let lastDay = ''
  return messages.map((m) => {
    const day = formatDay(m.at, timezone)
    const file = parseFileShared(m.body)
    const ev: TimelineEvent = {
      id: m.id,
      at: m.at,
      time: formatTime(m.at, timezone),
      day: day !== lastDay ? day : null,
      who: m.direction === 'outgoing' ? 'team' : 'client',
      senderName: m.senderName,
      file,
      text: file ? file.caption : m.body,
    }
    lastDay = day
    return ev
  })
}
