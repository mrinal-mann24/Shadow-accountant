import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { maskCredentials } from '@/lib/ai/redact'
import type { AppUser } from '@/lib/auth/types'
import { getClient, listConversations, listDocuments, listMeetings } from '@/lib/data'
import type { ClientDetail, ConversationItem, DocumentItem, MeetingItem } from '@/lib/data/types'
import { effectiveDirection, getTeamNumbers, normalizePhone } from '@/lib/team'
import {
  clientLabel,
  fileLabel,
  meetingLabel,
  messageLabel,
  shorten,
  sourceLink,
  ticketLabel,
  type CitationRegistry,
} from './citations'
import { embedModelId, embedTexts } from './models'
import { searchClientIds, toolClientId, type ChatScope } from './scope'
import { supabaseAgentStore, VECTOR_SEARCH_APPROVED, type AgentStore, type MessageHit } from './store'

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
}

export const defaultToolDeps: ToolDeps = {
  store: supabaseAgentStore,
  teamNumbers: getTeamNumbers,
  listConversations,
  listDocuments,
  listMeetings,
  getClient,
  embedQuery: async (text) => {
    if (!embedModelId()) return null
    const [v] = await embedTexts([text])
    return v ?? null
  },
}

export const SEARCH_LIMIT = 12
export const LIST_LIMIT = 25
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
      if (VECTOR_SEARCH_APPROVED) {
        try {
          if ((await deps.store.countEmbedded(s.clientIds)) > 0) {
            const emb = await deps.embedQuery(q)
            if (emb) vector = await deps.store.searchMessagesVector(emb, s.clientIds, SEARCH_LIMIT)
          }
        } catch {
          vector = [] // full text still answers; vector search is a bonus
        }
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
          sender: h.sender_name,
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
          label: ticketLabel(t, timeZone),
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
          subject: m.subject,
          start: m.start ?? m.date,
          durationMinutes: m.durationMinutes,
          organizer: m.organizerName,
          clientContact: m.pocName,
          hasTranscript: m.hasTranscript,
          excerpt: maskCredentials(transcriptExcerpt(transcripts.get(m.id) ?? null, query)),
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

  return { searchMessages, getTickets, getFiles, getMeetings, getClientProfile }
}

export type ChatTools = ReturnType<typeof createChatTools>
