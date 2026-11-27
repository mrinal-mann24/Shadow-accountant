import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/db/types'
import { isActiveClient } from '@/lib/data/client-status'
import { closedByMap } from '@/lib/data/conversations'
import type { ClosedBy } from '@/lib/data/types'
import type { TicketForCard } from './types'

// Read-only queries for the teams-notify job (service role). Every query is scoped to the pilot client ids
// the job passes in. The job talks to NotifyReads so it can be tested with an in-memory fake.

/** council_enabled and not Inactive. */
export type PilotClient = { clientId: string; clientName: string; vaId: string | null }

export type UploadForNotify = {
  uploadId: string
  clientId: string
  clientName: string
  fileName: string | null
  uploadedAt: string
  senderPhone: string | null
  /** Text the sender typed under the file on WhatsApp (raw; the card masks it). Null when there was none. */
  caption: string | null
}

/**
 * warn is called with one line when a query returns exactly MAX_ROWS rows: rows are read oldest first, so the
 * newest may be missing. The job lists these lines in details.warnings (not errors, so the cron stays 200).
 */
export type ReadWarn = { warn?: (line: string) => void }

export interface NotifyReads {
  pilotClients(): Promise<PilotClient[]>
  /** status open, created_at >= createdSince AND opened_at >= openedSince. */
  newTickets(clients: PilotClient[], o: { createdSince: string; openedSince: string } & ReadWarn): Promise<TicketForCard[]>
  /** status open, last_message_direction 'incoming', last_message_at >= lastMessageSince. */
  waitingTickets(clients: PilotClient[], o: { lastMessageSince: string } & ReadWarn): Promise<TicketForCard[]>
  /** uploaded_at >= uploadedSince, oldest first. */
  newUploads(clientIds: string[], o: { uploadedSince: string } & ReadWarn): Promise<UploadForNotify[]>
  /**
   * Ids of the tickets our team has already answered: a team message in the client's group after the ticket's last
   * client message that the council linked to this ticket, or that the council has not read yet (it runs every 15
   * minutes, reminders every 5). A team message the council put on another ticket or judged not a reply (no_action)
   * does not count: the council reads the conversation, so "hello sir" a day later is not taken as an answer.
   */
  repliedTickets(tickets: WaitingRef[]): Promise<Set<string>>
  /**
   * Cards still live in Teams for tickets closed outside Teams (by the ticket council or in Shadow) since closedSince:
   * ticket / reminder / escalation rows with a saved activity id and no click recorded. Such a card still shows its
   * Close button; the job updates it to "closed".
   */
  closedTicketCards(clients: PilotClient[], o: { closedSince: string } & ReadWarn): Promise<ClosedTicketCard[]>
}

export type WaitingRef = Pick<TicketForCard, 'id' | 'clientId' | 'lastMessageAt'>

/** One live card (its teams_notifications row) of a closed ticket. */
export type ClosedTicketCard = {
  kind: 'ticket' | 'reminder' | 'escalation'
  refId: string
  channelId: string
  activityId: string
  ticket: TicketForCard
  closedAt: string
  closedBy: ClosedBy
}

const TICKET_COLUMNS =
  'id, client_id, status, opened_at, created_at, last_message_at, last_message_direction, va_id, sla_breached, title, summary, tag'
export const MAX_ROWS = 500

/** The warning line for a query that hit MAX_ROWS. */
export function rowLimitWarning(what: string): string {
  return `${what}: hit the ${MAX_ROWS}-row limit, newest may be missing`
}

function warnIfCapped(what: string, rows: unknown[] | null, o: ReadWarn): void {
  if ((rows?.length ?? 0) >= MAX_ROWS) o.warn?.(rowLimitWarning(what))
}

type ConversationRow = Pick<
  Database['public']['Tables']['conversations']['Row'],
  | 'id'
  | 'client_id'
  | 'status'
  | 'opened_at'
  | 'created_at'
  | 'last_message_at'
  | 'last_message_direction'
  | 'va_id'
  | 'sla_breached'
  | 'title'
  | 'summary'
  | 'tag'
>

function fail(where: string, error: { message: string } | null): void {
  if (error) throw new Error(`teams-notify ${where}: ${error.message}`)
}

export function supabaseNotifyReads(db: SupabaseClient<Database>): NotifyReads {
  async function vaNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!ids.length) return out
    const { data, error } = await db.from('vas').select('va_id, va_name').in('va_id', ids)
    fail('vas', error)
    for (const v of data ?? []) out.set(v.va_id, v.va_name)
    return out
  }

  async function toCards(rows: ConversationRow[], clients: PilotClient[]): Promise<TicketForCard[]> {
    const byId = new Map(clients.map((c) => [c.clientId, c]))
    const scoped = rows.filter((r) => byId.has(r.client_id))
    const vaIdOf = (r: ConversationRow) => r.va_id ?? byId.get(r.client_id)?.vaId ?? null
    const names = await vaNames([...new Set(scoped.map(vaIdOf).filter((v): v is string => !!v))])
    return scoped.map((r) => {
      const vaId = vaIdOf(r)
      return {
        id: r.id,
        clientId: r.client_id,
        clientName: byId.get(r.client_id)!.clientName,
        title: r.title,
        summary: r.summary,
        tag: r.tag,
        status: r.status,
        openedAt: r.opened_at,
        lastMessageAt: r.last_message_at,
        lastMessageDirection: r.last_message_direction,
        vaId,
        vaName: vaId ? (names.get(vaId) ?? null) : null,
        slaBreached: r.sla_breached,
      }
    })
  }

  return {
    async pilotClients() {
      const { data, error } = await db
        .from('clients')
        .select('client_id, client_name, va_id, status')
        .eq('council_enabled', true)
      fail('clients', error)
      return (data ?? [])
        .filter((c) => isActiveClient(c.status))
        .map((c) => ({ clientId: c.client_id, clientName: c.client_name, vaId: c.va_id }))
    },

    async newTickets(clients, o) {
      if (!clients.length) return []
      const { data, error } = await db
        .from('conversations')
        .select(TICKET_COLUMNS)
        .in(
          'client_id',
          clients.map((c) => c.clientId),
        )
        .eq('status', 'open')
        .gte('created_at', o.createdSince)
        .gte('opened_at', o.openedSince)
        .order('created_at', { ascending: true })
        .limit(MAX_ROWS)
      fail('new tickets', error)
      warnIfCapped('new tickets', data, o)
      return toCards(data ?? [], clients)
    },

    async waitingTickets(clients, o) {
      if (!clients.length) return []
      const { data, error } = await db
        .from('conversations')
        .select(TICKET_COLUMNS)
        .in(
          'client_id',
          clients.map((c) => c.clientId),
        )
        .eq('status', 'open')
        .eq('last_message_direction', 'incoming')
        .gte('last_message_at', o.lastMessageSince)
        .order('last_message_at', { ascending: true })
        .limit(MAX_ROWS)
      fail('waiting tickets', error)
      warnIfCapped('waiting tickets', data, o)
      return toCards(data ?? [], clients)
    },

    async repliedTickets(tickets) {
      // One exact existence check per waiting ticket (only overdue ones reach here, so a handful): no shared row cap
      // can hide a recent reply.
      const replied = await Promise.all(
        tickets.map(async (t) => {
          const { data, error } = await db
            .from('client_messages')
            .select('message_id')
            .eq('client_id', t.clientId)
            .eq('direction', 'outgoing')
            .gt('message_timestamp', t.lastMessageAt)
            .or(`processed_at.is.null,conversation_id.eq.${t.id}`)
            .limit(1)
          fail('team replies', error)
          return (data?.length ?? 0) > 0 ? t.id : null
        }),
      )
      return new Set(replied.filter((id): id is string => id !== null))
    },

    async closedTicketCards(clients, o) {
      if (!clients.length) return []
      const clientIds = clients.map((c) => c.clientId)
      const closed = await db
        .from('conversations')
        .select(`${TICKET_COLUMNS}, closed_at`)
        .in('client_id', clientIds)
        .eq('status', 'closed')
        .gte('closed_at', o.closedSince)
        .order('closed_at', { ascending: true })
        .limit(MAX_ROWS)
      fail('closed tickets', closed.error)
      warnIfCapped('closed tickets', closed.data, o)
      const tickets = (closed.data ?? []).filter((t): t is typeof t & { closed_at: string } => !!t.closed_at)
      if (!tickets.length) return []

      const live = await db
        .from('teams_notifications')
        .select('kind, ref_id, channel_id, activity_id')
        .in('client_id', clientIds)
        .in('kind', ['ticket', 'reminder', 'escalation'])
        .is('action', null)
        .not('activity_id', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(MAX_ROWS)
      fail('live cards', live.error)
      warnIfCapped('live cards', live.data, o)
      const byTicket = new Map(tickets.map((t) => [t.id, t]))
      const rows = (live.data ?? []).filter((r) => r.activity_id && byTicket.has(r.ref_id.split('@')[0]))
      if (!rows.length) return []

      const used = [...new Set(rows.map((r) => r.ref_id.split('@')[0]))].map((id) => byTicket.get(id)!)
      const [cards, by] = await Promise.all([
        toCards(used, clients),
        closedByMap(
          db,
          used.map((t) => ({ id: t.id, closedAt: t.closed_at })),
        ),
      ])
      const cardById = new Map(cards.map((c) => [c.id, c]))
      return rows.flatMap((r) => {
        const id = r.ref_id.split('@')[0]
        const ticket = cardById.get(id)
        const t = byTicket.get(id)!
        if (!ticket) return []
        return [
          {
            kind: r.kind as ClosedTicketCard['kind'],
            refId: r.ref_id,
            channelId: r.channel_id,
            activityId: r.activity_id!,
            ticket,
            closedAt: t.closed_at,
            closedBy: by.get(id) ?? 'person',
          },
        ]
      })
    },

    async newUploads(clientIds, o) {
      if (!clientIds.length) return []
      const { data, error } = await db
        .from('document_uploads')
        .select('upload_id, client_id, client_name, file_name, uploaded_at, sender_phone, caption')
        .in('client_id', clientIds)
        .gte('uploaded_at', o.uploadedSince)
        .order('uploaded_at', { ascending: true })
        .limit(MAX_ROWS)
      fail('new uploads', error)
      warnIfCapped('new uploads', data, o)
      return (data ?? [])
        .filter((u) => u.client_id !== null && u.uploaded_at !== null)
        .map((u) => ({
          uploadId: u.upload_id,
          clientId: u.client_id!,
          clientName: u.client_name,
          fileName: u.file_name,
          uploadedAt: u.uploaded_at!,
          senderPhone: u.sender_phone,
          caption: u.caption ?? null,
        }))
    },
  }
}
