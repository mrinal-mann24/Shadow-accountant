import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { maskCredentials, maskNullable } from '@/lib/ai/redact'
import type { AppUser } from '@/lib/auth/types'
import {
  getClient,
  getTeamOverview,
  listClients,
  listConversations,
  listDocuments,
  listDueFollowUps,
  listFollowUps,
  listMeetings,
  listMessages,
  listRecentActivity,
} from '@/lib/data'
import type {
  ActivityItem,
  ClientDetail,
  ClientListItem,
  ConversationItem,
  DocumentItem,
  MeetingItem,
  MessageItem,
  TeamOverview,
} from '@/lib/data/types'
import type { FollowUpView } from '@/lib/followups/types'
import { effectiveDirection, getTeamNumbers, normalizePhone } from '@/lib/team'
import {
  clientLabel,
  fileLabel,
  formatCitationDate,
  formatCitationTime,
  meetingLabel,
  messageLabel,
  shorten,
  sourceLink,
  ticketLabel,
  type CitationRegistry,
} from './citations'
import { embedModelId, embedTexts } from './models'
import { clientsOfAccountant, searchClientIds, toolClientId, type ChatScope } from './scope'
import { supabaseAgentStore, type AgentStore, type MessageHit } from './store'

// Read-only tools for the client chat. Every tool is scoped twice: by the chat scope (the user's own client
// list, see lib/agent/scope.ts) and by lib/data, which checks the AppUser again. Every result item carries a
// citation { n, kind, id, clientId, at, label, link }. No tool writes or sends anything.

export type ToolDeps = {
  store: AgentStore
  teamNumbers: () => Promise<Set<string>>
  listConversations: (user: AppUser, f: { clientId?: string; status?: 'open' | 'closed' }) => Promise<ConversationItem[]>
  listDocuments: (user: AppUser, clientId: string) => Promise<DocumentItem[]>
  listMeetings: (user: AppUser, clientId: string) => Promise<MeetingItem[]>
  getClient: (user: AppUser, clientId: string) => Promise<ClientDetail | null>
  /** Embedding of the search text, or null when embeddings are not available. */
  embedQuery: (text: string) => Promise<number[] | null>
  listClients: (user: AppUser, f: { status?: 'active' | 'inactive' | 'all' }) => Promise<ClientListItem[]>
  listMessages: (user: AppUser, clientId: string, o: { before?: string; limit?: number }) => Promise<MessageItem[]>
  listRecentActivity: (user: AppUser, o: { sinceHours?: number; limit?: number; clientOnly?: boolean }) => Promise<ActivityItem[]>
  listFollowUps: (user: AppUser, clientId: string, o: { status?: 'open' | 'all'; limit?: number }) => Promise<FollowUpView[]>
  listDueFollowUps: (user: AppUser, o: { limit?: number }) => Promise<FollowUpView[]>
  /** Admin and Engineer only (throws ForbiddenError otherwise). */
  getTeamOverview: (user: AppUser) => Promise<TeamOverview>
}

export const defaultToolDeps: ToolDeps = {
  store: supabaseAgentStore,
  teamNumbers: getTeamNumbers,
  listConversations,
  listDocuments,
  listMeetings,
  getClient,
  listClients,
  listMessages,
  listRecentActivity,
  listFollowUps,
  listDueFollowUps,
  getTeamOverview,
  embedQuery: async (text) => {
    if (!embedModelId()) return null
    const [v] = await embedTexts([text])
    return v ?? null
  },
}

export const SEARCH_LIMIT = 12
export const LIST_LIMIT = 25
/** Tickets shown by listTicketsAcross (counts still cover all of them). */
export const ACROSS_LIMIT = 30
/** Clients shown by clientsOverview (totals still cover all of them). */
export const OVERVIEW_LIMIT = 40
/** Most messages recentMessages returns. */
export const MESSAGES_LIMIT = 50
/** Items shown by recentActivity (counts still cover all of them). */
export const ACTIVITY_LIMIT = 40
const BODY_CHARS = 600
const EXCERPT_CHARS = 600

type Ctx = { user: AppUser; scope: ChatScope; registry: CitationRegistry; timeZone: string; deps?: Partial<ToolDeps> }

/** Up to EXCERPT_CHARS of a transcript around the first word of the query that appears (start when none). */
export function transcriptExcerpt(transcript: string | null, query: string | null | undefined): string {
  const t = (transcript ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const words = (query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  const lower = t.toLowerCase()
  let at = -1
  for (const w of words) {
    at = lower.indexOf(w)
    if (at >= 0) break
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 150)
  const slice = t.slice(start, start + EXCERPT_CHARS)
  return `${start > 0 ? '...' : ''}${slice}${start + EXCERPT_CHARS < t.length ? '...' : ''}`
}

/** True when every word of the query (case-insensitive) is in the text. Empty query matches everything. */
export function matchesAllWords(text: string, query: string | null | undefined): boolean {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  return words.every((w) => lower.includes(w))
}

/** Joins full-text and vector hits: full text first, no duplicates, only clients in scope, at most `limit`. */
export function mergeHits(text: MessageHit[], vector: MessageHit[], clientIds: string[] | null, limit: number): MessageHit[] {
  const allowed = clientIds ? new Set(clientIds) : null
  const seen = new Set<string>()
  const out: MessageHit[] = []
  for (const h of [...text, ...vector]) {
    if (!h.client_id || (allowed && !allowed.has(h.client_id)) || seen.has(h.message_id)) continue
    seen.add(h.message_id)
    out.push(h)
    if (out.length >= limit) break
  }
  return out
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createChatTools(ctx: Ctx) {
  const deps: ToolDeps = { ...defaultToolDeps, ...ctx.deps }
  const { user, scope, registry, timeZone } = ctx
  const names = new Map(scope.clients.map((c) => [c.id, c.name]))
  const clientIdField = z
    .string()
    .optional()
    .describe(scope.fixedClientId ? 'Leave out: the chat is locked to the picked client.' : 'clientId from the list of clients.')

  const searchMessages = tool({
    description:
      'Search WhatsApp messages by words (full text, newest first). Use short keyword queries such as "gst return" or "bank statement". Returns up to 12 messages with citation numbers.',
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe('Words to search for.'),
      clientId: clientIdField,
    }),
    execute: async ({ query, clientId }) => {
      const s = searchClientIds(scope, clientId)
      if (!s.ok) return { items: [], error: s.error }
      const q = query.replace(/[\u0000-\u001f]/g, ' ').trim()
      let text: MessageHit[]
      try {
        text = await deps.store.searchMessagesText(q, s.clientIds, SEARCH_LIMIT)
      } catch (e) {
        return { items: [], error: `Search failed: ${errMsg(e)}` }
      }
      let vector: MessageHit[] = []
      try {
        if ((await deps.store.countEmbedded(s.clientIds)) > 0) {
          const emb = await deps.embedQuery(q)
          if (emb) vector = await deps.store.searchMessagesVector(emb, s.clientIds, SEARCH_LIMIT)
        }
      } catch {
        vector = [] // full text still answers; vector search is a bonus
      }
      const hits = mergeHits(text, vector, s.clientIds, SEARCH_LIMIT)
      const team = hits.length > 0 ? await deps.teamNumbers() : new Set<string>()
      const items = hits.map((h) => {
        const clientId = h.client_id as string
        const phone = normalizePhone(h.sender_phone)
        const fromTeam = phone !== null && team.has(phone)
        const citation = registry.add({
          kind: 'message',
          id: h.message_id,
          clientId,
          at: h.message_timestamp,
          label: messageLabel({ at: h.message_timestamp, senderName: h.sender_name, fromTeam }, timeZone),
          link: sourceLink('message', clientId, h.message_id),
        })
        return {
          n: citation.n,
          citation,
          client: names.get(clientId) ?? null,
          at: h.message_timestamp,
          sender: maskNullable(h.sender_name),
          direction: effectiveDirection(h, team),
          text: shorten(maskCredentials(h.body), BODY_CHARS),
        }
      })
      return { searched: q, items }
    },
  })

  const getTickets = tool({
    description: 'List tickets (issues raised in WhatsApp) for a client, most recent activity first, with status, tag and summary.',
    inputSchema: z.object({
      clientId: clientIdField,
      status: z.enum(['open', 'closed']).optional().describe('Only open or only closed tickets.'),
    }),
    execute: async ({ clientId, status }) => {
      const c = toolClientId(scope, clientId)
      if (!c.ok) return { items: [], error: c.error }
      const rows = (await deps.listConversations(user, { clientId: c.clientId, status })).slice(0, LIST_LIMIT)
      const items = rows.map((t) => {
        const citation = registry.add({
          kind: 'ticket',
          id: t.id,
          clientId: t.clientId,
          at: t.openedAt,
          label: maskCredentials(ticketLabel(t, timeZone)),
          link: sourceLink('ticket', t.clientId, t.id),
        })
        return {
          n: citation.n,
          citation,
          title: t.title ? maskCredentials(t.title) : null,
          summary: shorten(maskCredentials(t.summary), 400),
          status: t.status,
          tag: t.tag,
          fault: t.fault,
          openedAt: t.openedAt,
          closedAt: t.closedAt,
          lastMessageAt: t.lastMessageAt,
          messageCount: t.messageCount,
          slaBreached: t.slaBreached,
        }
      })
      return { items }
    },
  })

  const listTicketsAcross = tool({
    description:
      'Tickets across many clients in one call: all clients the user may see, or only the clients of one accountant (by name, for example "Puneeth"). Open tickets by default. Returns per-client counts and the most recent tickets.',
    inputSchema: z.object({
      accountant: z.string().max(100).optional().describe('Accountant name or part of it. Leave out for all clients.'),
      status: z.enum(['open', 'closed']).optional().describe('Default open.'),
      slaBreachedOnly: z.boolean().optional().describe('Only tickets past their SLA.'),
      openedInLastDays: z.number().int().min(1).max(90).optional().describe('Only tickets opened in the last N days (1 = today and yesterday).'),
      tag: z.enum(['escalation', 'complaint', 'neutral', 'positive', 'suspense']).optional().describe('Only tickets with this tag.'),
    }),
    execute: async ({ accountant, status, slaBreachedOnly, openedInLastDays, tag }) => {
      if (scope.fixedClientId) return { items: [], error: 'The chat is locked to one client: use getTickets.' }
      const clients = clientsOfAccountant(scope.clients, accountant)
      if (clients.length === 0) {
        const known = [...new Set(scope.clients.map((c) => c.accountant).filter((a): a is string => !!a))].sort()
        return { items: [], error: `No clients found for accountant "${accountant ?? ''}".`, accountants: known }
      }
      const allowed = new Set(clients.map((c) => c.id))
      const openedAfter = openedInLastDays ? Date.now() - openedInLastDays * 86_400_000 : null
      const rows = (await deps.listConversations(user, { status: status ?? 'open', ...(tag ? { tag } : {}) })).filter(
        (t) =>
          allowed.has(t.clientId) &&
          (!slaBreachedOnly || t.slaBreached) &&
          (openedAfter === null || Date.parse(t.openedAt) >= openedAfter),
      )
      const perClient = new Map<string, number>()
      for (const t of rows) perClient.set(t.clientId, (perClient.get(t.clientId) ?? 0) + 1)
      const items = rows.slice(0, ACROSS_LIMIT).map((t) => {
        const citation = registry.add({
          kind: 'ticket',
          id: t.id,
          clientId: t.clientId,
          at: t.openedAt,
          label: maskCredentials(ticketLabel(t, timeZone)),
          link: sourceLink('ticket', t.clientId, t.id),
        })
        return {
          n: citation.n,
          citation,
          client: names.get(t.clientId) ?? t.clientName,
          title: t.title ? maskCredentials(t.title) : null,
          summary: shorten(maskCredentials(t.summary), 200),
          status: t.status,
          tag: t.tag,
          openedAt: t.openedAt,
          lastMessageAt: t.lastMessageAt,
          slaBreached: t.slaBreached,
        }
      })
      return {
        clientsChecked: clients.length,
        totalTickets: rows.length,
        shown: items.length,
        perClient: [...perClient.entries()]
          .map(([id, count]) => ({ client: names.get(id) ?? id, count }))
          .sort((a, b) => b.count - a.count),
        items,
      }
    },
  })

  const getFiles = tool({
    description:
      'List files the client shared (saved to SharePoint), newest first. Optional words to match in the file name or folder.',
    inputSchema: z.object({
      clientId: clientIdField,
      query: z.string().max(200).optional().describe('Words that must appear in the file name or folder, for example "bank statement".'),
    }),
    execute: async ({ clientId, query }) => {
      const c = toolClientId(scope, clientId)
      if (!c.ok) return { items: [], error: c.error }
      const docs = (await deps.listDocuments(user, c.clientId))
        .filter((d) => matchesAllWords(d.path, query))
        .slice(0, LIST_LIMIT)
      const items = docs.map((d) => {
        const citation = registry.add({
          kind: 'file',
          id: d.id,
          clientId: c.clientId,
          at: d.uploadedAt,
          label: fileLabel(d, timeZone),
          link: d.url ?? sourceLink('file', c.clientId, d.id),
        })
        return {
          n: citation.n,
          citation,
          fileName: d.fileName,
          folder: d.folderName,
          fileType: d.fileType,
          fileSize: d.fileSize,
          uploadedAt: d.uploadedAt,
          sharedIn: d.groupName,
        }
      })
      return { items }
    },
  })

  const getMeetings = tool({
    description:
      'List meetings with the client, newest first, with a short transcript excerpt. Optional words pick the part of the transcript to show.',
    inputSchema: z.object({
      clientId: clientIdField,
      query: z.string().max(200).optional().describe('Words to look for in the transcript.'),
    }),
    execute: async ({ clientId, query }) => {
      const c = toolClientId(scope, clientId)
      if (!c.ok) return { items: [], error: c.error }
      const meetings = (await deps.listMeetings(user, c.clientId)).slice(0, LIST_LIMIT)
      const transcripts = new Map<string, string | null>()
      if (meetings.some((m) => m.hasTranscript)) {
        for (const t of await deps.store.meetingsWithTranscript(c.clientId, LIST_LIMIT)) {
          if (t.client_id === c.clientId) transcripts.set(t.id, t.transcript)
        }
      }
      const items = meetings.map((m) => {
        const citation = registry.add({
          kind: 'meeting',
          id: m.id,
          clientId: c.clientId,
          at: m.start ?? m.date,
          label: meetingLabel(m, timeZone),
          link: sourceLink('meeting', c.clientId, m.id),
        })
        return {
          n: citation.n,
          citation,
          subject: maskNullable(m.subject),
          start: m.start ?? m.date,
          durationMinutes: m.durationMinutes,
          organizer: m.organizerName,
          clientContact: m.pocName,
          hasTranscript: m.hasTranscript,
          // Mask the whole transcript first, so the excerpt cut can never leave part of a value visible.
          excerpt: transcriptExcerpt(maskCredentials(transcripts.get(m.id) ?? null) || null, query),
        }
      })
      return { items }
    },
  })

  const getClientProfile = tool({
    description:
      'Client profile: names, status, deal stage, accountant, GSTIN, location, onboarding date, health scores, open tickets and contacts.',
    inputSchema: z.object({ clientId: clientIdField }),
    execute: async ({ clientId }) => {
      const c = toolClientId(scope, clientId)
      if (!c.ok) return { items: [], error: c.error }
      const p = await deps.getClient(user, c.clientId)
      if (!p) return { items: [], error: 'Client not found.' }
      const citation = registry.add({
        kind: 'client',
        id: p.id,
        clientId: p.id,
        at: null,
        label: clientLabel(p.name),
        link: sourceLink('client', p.id, p.id),
      })
      return {
        items: [
          {
            n: citation.n,
            citation,
            name: p.name,
            legalName: p.legalName,
            status: p.status,
            dealStage: p.dealStage,
            accountant: p.vaName,
            whatsappGroup: p.whatsappGroupName,
            gstin: p.gstin,
            entityType: p.entityType,
            industry: p.industry,
            city: p.city,
            state: p.state,
            onboardingDate: p.onboardingDate,
            serviceScore: p.serviceScore,
            moodScore: p.moodScore,
            scoreReasons: p.topReasons,
            openTickets: p.openTickets,
            openEscalations: p.openEscalations,
            lastMessageAt: p.lastMessageAt,
            contacts: p.contacts.map((x) => ({ name: x.name, role: x.role, isPrimary: x.isPrimary })),
          },
        ],
      }
    },
  })

  const inScope = new Set(scope.clients.map((c) => c.id))
  const clientCitation = (clientId: string, label: string) =>
    registry.add({ kind: 'client', id: clientId, clientId, at: null, label, link: sourceLink('client', clientId, clientId) })

  const clientsOverview = tool({
    description:
      'Overview of the clients the user may see (or one accountant\'s clients): health score, mood, open tickets and escalations, clients waiting for a reply and for how long, last message. Use for "my clients", "which clients need attention", "lowest health", "who is waiting".',
    inputSchema: z.object({
      accountant: z.string().max(100).optional().describe('Accountant name or part of it. Leave out for all clients the user may see.'),
      sortBy: z
        .enum(['attention', 'health', 'tickets', 'waiting', 'name'])
        .optional()
        .describe('attention (default): waiting clients, escalations and low health first; health: lowest score first; tickets: most open tickets first; waiting: longest wait first.'),
      includeInactive: z.boolean().optional().describe('Also list inactive clients. Default false.'),
    }),
    execute: async ({ accountant, sortBy, includeInactive }) => {
      if (scope.fixedClientId) return { items: [], error: 'The chat is locked to one client: use getClientProfile.' }
      const allowed = new Set(clientsOfAccountant(scope.clients, accountant).map((c) => c.id))
      if (allowed.size === 0) {
        const known = [...new Set(scope.clients.map((c) => c.accountant).filter((a): a is string => !!a))].sort()
        return { items: [], error: `No clients found for accountant "${accountant ?? ''}".`, accountants: known }
      }
      const rows = (await deps.listClients(user, { status: includeInactive ? 'all' : 'active' })).filter((c) => allowed.has(c.id))
      const score = (v: number | null) => (v === null ? 101 : v)
      const order: Record<string, (a: ClientListItem, b: ClientListItem) => number> = {
        attention: (a, b) =>
          (b.unansweredCount ?? 0) - (a.unansweredCount ?? 0) ||
          b.openEscalations - a.openEscalations ||
          score(a.serviceScore) - score(b.serviceScore) ||
          b.openTickets - a.openTickets,
        health: (a, b) => score(a.serviceScore) - score(b.serviceScore),
        tickets: (a, b) => b.openTickets - a.openTickets,
        waiting: (a, b) => (b.worstLagMinutes ?? -1) - (a.worstLagMinutes ?? -1),
        name: (a, b) => a.name.localeCompare(b.name),
      }
      rows.sort(order[sortBy ?? 'attention'])
      const scored = rows.filter((c) => c.serviceScore !== null)
      const items = rows.slice(0, OVERVIEW_LIMIT).map((c) => {
        const citation = clientCitation(c.id, clientLabel(c.name))
        return {
          n: citation.n,
          citation,
          client: c.name,
          accountant: c.vaName,
          status: c.status,
          serviceScore: c.serviceScore,
          serviceChange: c.serviceDelta,
          moodScore: c.moodScore,
          openTickets: c.openTickets,
          openEscalations: c.openEscalations,
          unansweredMessages: c.unansweredCount,
          longestWaitMinutes: c.worstLagMinutes,
          lastMessageAt: c.lastMessageAt,
          scoredAt: c.scoreComputedAt,
        }
      })
      return {
        totalClients: rows.length,
        shown: items.length,
        totals: {
          openTickets: rows.reduce((s, c) => s + c.openTickets, 0),
          openEscalations: rows.reduce((s, c) => s + c.openEscalations, 0),
          clientsWaitingForReply: rows.filter((c) => (c.unansweredCount ?? 0) > 0).length,
          averageServiceScore: scored.length ? Math.round(scored.reduce((s, c) => s + (c.serviceScore ?? 0), 0) / scored.length) : null,
          notScoredYet: rows.length - scored.length,
        },
        items,
      }
    },
  })

  const recentMessages = tool({
    description:
      "A client's latest WhatsApp messages in time order (oldest first), from the client and the team. Use for \"what did the client say yesterday\", \"last messages\", \"has the team replied\". Optional: only messages before a date.",
    inputSchema: z.object({
      clientId: clientIdField,
      limit: z.number().int().min(1).max(MESSAGES_LIMIT).optional().describe(`How many, default 20, at most ${MESSAGES_LIMIT}.`),
      before: z.string().max(30).optional().describe('Only messages before this day or time (YYYY-MM-DD or ISO), for older history.'),
    }),
    execute: async ({ clientId, limit, before }) => {
      const c = toolClientId(scope, clientId)
      if (!c.ok) return { items: [], error: c.error }
      const rows = await deps.listMessages(user, c.clientId, { limit: limit ?? 20, ...(before ? { before } : {}) })
      const items = [...rows].reverse().map((m) => {
        const citation = registry.add({
          kind: 'message',
          id: m.id,
          clientId: c.clientId,
          at: m.at,
          label: messageLabel({ at: m.at, senderName: m.senderName, fromTeam: m.fromTeam }, timeZone),
          link: sourceLink('message', c.clientId, m.id),
        })
        return {
          n: citation.n,
          citation,
          at: m.at,
          sender: maskNullable(m.senderName),
          from: m.fromTeam ? 'team' : 'client',
          text: shorten(maskCredentials(m.body), BODY_CHARS),
        }
      })
      return { client: names.get(c.clientId) ?? null, items }
    },
  })

  const recentActivity = tool({
    description:
      'What happened recently across the clients the user may see (or one accountant\'s clients): client messages, new files, meetings and new tickets, newest first. Use for "what happened today", "any new files", "which clients messaged".',
    inputSchema: z.object({
      hours: z.number().int().min(1).max(168).optional().describe('Look back this many hours, default 24, at most 168 (7 days).'),
      accountant: z.string().max(100).optional().describe('Only this accountant\'s clients.'),
      includeTeamMessages: z.boolean().optional().describe('Also include messages and files our team sent. Default false (client activity only).'),
    }),
    execute: async ({ hours, accountant, includeTeamMessages }) => {
      const allowed = scope.fixedClientId
        ? new Set([scope.fixedClientId])
        : new Set(clientsOfAccountant(scope.clients, accountant).map((c) => c.id))
      const rows = (
        await deps.listRecentActivity(user, { sinceHours: hours ?? 24, limit: 200, clientOnly: !includeTeamMessages })
      ).filter((a) => allowed.has(a.clientId))
      const counts: Record<string, number> = {}
      for (const a of rows) counts[a.kind] = (counts[a.kind] ?? 0) + 1
      const items = rows.slice(0, ACTIVITY_LIMIT).map((a) => {
        const kind = a.kind === 'document' ? 'file' : a.kind
        const citation = registry.add({
          kind,
          id: a.id,
          clientId: a.clientId,
          at: a.at,
          label: `${kind === 'file' ? 'File' : kind === 'message' ? 'WhatsApp' : kind === 'meeting' ? 'Meeting' : 'Ticket'}, ${formatCitationTime(a.at, timeZone)}, ${shorten(a.clientName ?? names.get(a.clientId) ?? '', 50)}`,
          link: a.link ?? sourceLink(kind, a.clientId, a.id),
        })
        return {
          n: citation.n,
          citation,
          kind,
          client: a.clientName ?? names.get(a.clientId) ?? null,
          at: a.at,
          title: shorten(maskCredentials(a.title), 160),
          detail: a.detail ? shorten(maskCredentials(a.detail), 300) : null,
          ...(a.direction ? { direction: a.direction } : {}),
        }
      })
      return { hours: hours ?? 24, total: rows.length, byKind: counts, shown: items.length, items }
    },
  })

  const getFollowUps = tool({
    description:
      'Follow-ups: promises the team made, documents asked from the client, and repeat asks. With a client: all its open and missed follow-ups. Without: those due by the end of today (or overdue) across the clients the user may see.',
    inputSchema: z.object({
      clientId: z.string().optional().describe('clientId for one client. Leave out for everything due today across clients.'),
      kind: z.enum(['promise', 'document', 'repeat_ask']).optional().describe('Only this kind.'),
    }),
    execute: async ({ clientId, kind }) => {
      let rows: FollowUpView[]
      let what: string
      if (clientId || scope.fixedClientId) {
        const c = toolClientId(scope, clientId)
        if (!c.ok) return { items: [], error: c.error }
        rows = await deps.listFollowUps(user, c.clientId, { status: 'open' })
        what = `open and missed follow-ups for ${names.get(c.clientId) ?? c.clientId}`
      } else {
        rows = (await deps.listDueFollowUps(user, { limit: 100 })).filter((f) => inScope.has(f.clientId))
        what =
          'follow-ups due by the end of today or overdue, across clients. This list leaves out items found while scanning old messages (from before Shadow started tracking them, such as the pilot history); say so, and offer to list one client, which shows all its open items.'
      }
      if (kind) rows = rows.filter((f) => f.kind === kind)
      const items = rows.slice(0, LIST_LIMIT).map((f) => {
        const citation = registry.add({
          kind: 'client',
          id: f.id,
          clientId: f.clientId,
          at: f.sourceAt,
          label: `Follow-up (${f.kind.replace('_', ' ')}), ${shorten(f.clientName, 40)}, ${formatCitationDate(f.sourceAt, timeZone)}`,
          link: sourceLink('client', f.clientId, f.clientId),
        })
        return {
          n: citation.n,
          citation,
          client: f.clientName,
          kind: f.kind,
          item: shorten(maskCredentials(f.item), 300),
          status: f.status,
          dueAt: f.dueAt,
          askedAt: f.sourceAt,
          askedBy: maskNullable(f.sourceSender),
          accountant: f.vaName,
          remindersSent: f.reminderCount,
        }
      })
      return { what, total: rows.length, items }
    },
  })

  const tools = { searchMessages, getTickets, listTicketsAcross, getFiles, getMeetings, getClientProfile, clientsOverview, recentMessages, recentActivity, getFollowUps }

  // Team workload is for Admins and Engineers only (lib/data getTeamOverview checks the role again).
  if ((user.role === 'admin' || user.role === 'engineer') && !user.viewingAs && !scope.fixedClientId) {
    const teamOverview = tool({
      description:
        'Each accountant\'s workload: clients, open tickets, escalations, SLA breaches, clients waiting for a reply and average health; plus unassigned clients, open escalation tickets and the lowest-health clients. Admin and Engineer only.',
      inputSchema: z.object({}),
      execute: async () => {
        const t = await deps.getTeamOverview(user)
        const escalations = t.escalations.slice(0, 10).map((e) => {
          const citation = registry.add({ kind: 'ticket', id: e.id, clientId: e.clientId, at: e.openedAt, label: maskCredentials(ticketLabel(e, timeZone)), link: sourceLink('ticket', e.clientId, e.id) })
          return { n: citation.n, citation, client: e.clientName, title: e.title ? maskCredentials(e.title) : null, slaBreached: e.slaBreached, lastMessageAt: e.lastMessageAt }
        })
        const lowestHealth = t.lowestHealth.map((c) => {
          const citation = clientCitation(c.id, clientLabel(c.name))
          return { n: citation.n, citation, client: c.name, accountant: c.vaName, serviceScore: c.serviceScore }
        })
        return {
          accountants: t.accountants.map((a) => ({
            name: a.name,
            status: a.status,
            clients: a.clientCount,
            openTickets: a.openTickets,
            openEscalations: a.openEscalations,
            slaBreachedOpen: a.slaBreachedOpen,
            clientsWaitingForReply: a.unansweredClients,
            averageServiceScore: a.avgServiceScore,
          })),
          unassignedClients: t.unassignedClients,
          openEscalations: escalations,
          lowestHealth,
          hubspotLastSync: t.hubspotLastSync,
        }
      },
    })
    return { ...tools, teamOverview }
  }
  return tools
}

export type ChatTools = ReturnType<typeof createChatTools>
