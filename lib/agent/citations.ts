// Citations for the client chat. Pure and client-safe (used by the chat route, the tools and the chat UI).
// Every tool result item carries one citation; the model cites it as [n].

export type CitationKind = 'message' | 'file' | 'meeting' | 'ticket' | 'client'

export type Citation = {
  /** Number the model uses in the answer, as [n]. Unique within one chat. */
  n: number
  kind: CitationKind
  /** Id in the source table (message_id, upload_id, meeting id, conversation id, client_id). */
  id: string
  clientId: string
  /** ISO time of the source (message time, upload time, meeting start, ticket opened); null when unknown. */
  at: string | null
  label: string
  /** In-app page for the source, when one exists. */
  link?: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parts(iso: string, timeZone: string): Record<string, string> | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const out: Record<string, string> = {}
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  for (const p of f.formatToParts(d)) out[p.type] = p.value
  return out
}

/** "16 Nov 2026" in the given timezone (default Asia/Kolkata). '' for a missing or bad date. */
export function formatCitationDate(iso: string | null, timeZone = 'Asia/Kolkata'): string {
  if (!iso) return ''
  const p = parts(iso, timeZone)
  if (!p) return ''
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}`
}

/** "16 Nov 2026, 3:05 pm" in the given timezone (default Asia/Kolkata). '' for a missing or bad date. */
export function formatCitationTime(iso: string | null, timeZone = 'Asia/Kolkata'): string {
  if (!iso) return ''
  const p = parts(iso, timeZone)
  if (!p) return ''
  return `${formatCitationDate(iso, timeZone)}, ${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toLowerCase()}`.trim()
}

/** Collapses whitespace and cuts to `max` characters with "...". */
export function shorten(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

/** In-app link to a source on the client page. accountant-ui renders anchors with these ids. */
export function sourceLink(kind: CitationKind, clientId: string, id: string): string {
  const base = `/clients/${encodeURIComponent(clientId)}`
  return kind === 'client' ? base : `${base}#${kind}-${encodeURIComponent(id)}`
}

export function messageLabel(m: { at: string; senderName: string | null; fromTeam: boolean }, timeZone?: string): string {
  const who = m.senderName?.trim() ? m.senderName.trim() : m.fromTeam ? 'team' : 'client'
  return `WhatsApp, ${formatCitationTime(m.at, timeZone)}, ${shorten(who, 40)}`
}

export function fileLabel(f: { fileName: string | null; folderName: string; uploadedAt: string | null }, timeZone?: string): string {
  const name = shorten(f.fileName ?? f.folderName, 80) || 'Unnamed file'
  const date = formatCitationDate(f.uploadedAt, timeZone)
  return date ? `File ${name}, ${date}` : `File ${name}`
}

export function meetingLabel(m: { subject: string | null; start: string | null; date: string | null }, timeZone?: string): string {
  const name = shorten(m.subject, 80) || 'Untitled meeting'
  const when = m.start ? formatCitationTime(m.start, timeZone) : formatCitationDate(m.date, timeZone)
  return when ? `Meeting ${name}, ${when}` : `Meeting ${name}`
}

export function ticketLabel(t: { title: string | null; summary: string; openedAt: string }, timeZone?: string): string {
  const name = shorten(t.title || t.summary, 60) || 'Untitled ticket'
  return `Ticket ${name}, opened ${formatCitationDate(t.openedAt, timeZone)}`
}

export function clientLabel(name: string): string {
  return `Client profile, ${shorten(name, 80)}`
}

/** Hands out citation numbers for one chat request, starting at `start`. Same source gets the same number. */
export function createCitationRegistry(start = 1) {
  let next = Math.max(1, Math.floor(start))
  const byKey = new Map<string, Citation>()
  return {
    add(c: Omit<Citation, 'n'>): Citation {
      const key = `${c.kind}:${c.id}`
      const found = byKey.get(key)
      if (found) return found
      const cited: Citation = { ...c, n: next++ }
      byKey.set(key, cited)
      return cited
    },
    all(): Citation[] {
      return [...byKey.values()].sort((a, b) => a.n - b.n)
    },
  }
}
export type CitationRegistry = ReturnType<typeof createCitationRegistry>

const MARKER = /\[(\d{1,4}(?:\s*,\s*\d{1,4})*)\]/g

/** Citation numbers used in a text: "[1]", "[2, 3]" and "[4][5]". */
export function citedNumbers(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(MARKER)) for (const s of m[1].split(',')) out.push(Number(s.trim()))
  return out
}

/** First free number after every [n] already used in earlier answers, so numbers never repeat in a chat. */
export function nextCitationStart(previousAnswers: string[]): number {
  let max = 0
  for (const t of previousAnswers) for (const n of citedNumbers(t)) if (n > max) max = n
  return max + 1
}

export type AnswerSegment = { type: 'text'; text: string } | { type: 'cite'; n: number }

/** Splits an answer into text and citation markers for rendering chips. Unknown numbers stay as cites. */
export function splitCitations(text: string): AnswerSegment[] {
  const out: AnswerSegment[] = []
  let last = 0
  for (const m of text.matchAll(MARKER)) {
    const at = m.index ?? 0
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) })
    for (const s of m[1].split(',')) out.push({ type: 'cite', n: Number(s.trim()) })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/** Numbers cited in the answer that no tool returned (a sign the model made up a source). */
export function unknownCitations(text: string, known: Iterable<number>): number[] {
  const set = new Set(known)
  return [...new Set(citedNumbers(text))].filter((n) => !set.has(n))
}

function isCitation(v: unknown): v is Citation {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return typeof c.n === 'number' && typeof c.kind === 'string' && typeof c.id === 'string' && typeof c.label === 'string'
}

/** Pulls citations out of a tool output shaped { items: [{ citation }] }. Ignores anything else. */
export function citationsFromToolOutput(output: unknown): Citation[] {
  if (!output || typeof output !== 'object') return []
  const items = (output as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: Citation[] = []
  for (const it of items) {
    const c = it && typeof it === 'object' ? (it as { citation?: unknown }).citation : undefined
    if (isCitation(c)) out.push(c)
  }
  return out
}
