// Pure helpers for the Senior Accountant screens. Client-safe (types only from lib/data).
import { BUCKETS } from '@/lib/buckets'
import type { ClientListItem, ConversationItem, DocumentItem } from '@/lib/data/types'

export const DEFAULT_TIMEZONE = 'Asia/Kolkata'

// ---------------------------------------------------------------- Home KPIs

export type HomeKpis = {
  myClients: number
  openTickets: number
  slaBreached: number
  /** Mean service score of scored clients, rounded; null when none are scored. */
  avgHealth: number | null
  /** Clients whose latest score shows a client message waiting for a reply. */
  unanswered: number
}

export function computeHomeKpis(clients: ClientListItem[], openTickets: ConversationItem[]): HomeKpis {
  const open = openTickets.filter((t) => t.status === 'open')
  const scored = clients.map((c) => c.serviceScore).filter((s): s is number => s !== null)
  return {
    myClients: clients.length,
    openTickets: open.length,
    slaBreached: open.filter((t) => t.slaBreached).length,
    avgHealth: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
    unanswered: clients.filter((c) => (c.unansweredCount ?? 0) > 0).length,
  }
}

// ---------------------------------------------------------------- Buckets

export type BucketGroup = { key: string | null; label: string; clients: ClientListItem[] }

export const NO_BUCKET_LABEL = 'Bucket not set'

/** Groups clients by bucket in BUCKETS order, "Bucket not set" last. Empty groups are left out. */
export function groupClientsByBucket(clients: ClientListItem[], buckets: Map<string, string | null>): BucketGroup[] {
  const groups: BucketGroup[] = BUCKETS.map((b) => ({ key: b.key, label: b.label, clients: [] }))
  const none: BucketGroup = { key: null, label: NO_BUCKET_LABEL, clients: [] }
  for (const c of clients) {
    const key = buckets.get(c.id) ?? null
    const group = groups.find((g) => g.key === key) ?? none
    group.clients.push(c)
  }
  return [...groups, none].filter((g) => g.clients.length > 0)
}

// ---------------------------------------------------------------- Tickets

/** Minutes the client has been waiting on an open ticket (last message incoming), else null. */
export function ticketWaitMinutes(t: ConversationItem, now: Date): number | null {
  if (t.status !== 'open' || t.lastMessageDirection !== 'incoming') return null
  const at = Date.parse(t.lastMessageAt)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.round((now.getTime() - at) / 60_000))
}

/** Most urgent first: SLA breached, then longest client wait, then oldest last message. */
export function sortTicketsBySlaLag(tickets: ConversationItem[], now: Date): ConversationItem[] {
  return [...tickets].sort((a, b) => {
    if (a.slaBreached !== b.slaBreached) return a.slaBreached ? -1 : 1
    const wa = ticketWaitMinutes(a, now)
    const wb = ticketWaitMinutes(b, now)
    if (wa !== wb) {
      if (wa === null) return 1
      if (wb === null) return -1
      return wb - wa
    }
    return a.lastMessageAt.localeCompare(b.lastMessageAt)
  })
}

/** Free-text filter over ticket title, summary and client name. */
export function filterTickets(tickets: ConversationItem[], q: string | undefined): ConversationItem[] {
  const needle = q?.trim().toLowerCase()
  if (!needle) return tickets
  return tickets.filter((t) =>
    [t.title, t.summary, t.clientName].some((s) => s?.toLowerCase().includes(needle)),
  )
}

// ---------------------------------------------------------------- Files received

export const FILE_CATEGORIES = ['AR', 'AP', 'Bank', 'Other'] as const
export type FileCategory = (typeof FILE_CATEGORIES)[number]

export const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
  AR: 'AR (sales)',
  AP: 'AP (purchases)',
  Bank: 'Bank',
  Other: 'Other',
}

const BANK_RE = /\b(banks?|statements?|stmts?|passbooks?)\b/
const AP_RE = /\b(purchases?|bills?|expenses?|payables?|vendors?|creditors?|ap)\b/
const AR_RE = /\b(sales?|invoices?|receivables?|debtors?|revenue|ar)\b/

/** Best guess from folder and file name. Bank first, then AP (purchase invoices), then AR. */
export function categoriseDocument(d: Pick<DocumentItem, 'folderName' | 'fileName'>): FileCategory {
  const text = `${d.folderName} ${d.fileName ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  if (BANK_RE.test(text)) return 'Bank'
  if (AP_RE.test(text)) return 'AP'
  if (AR_RE.test(text)) return 'AR'
  return 'Other'
}

/** 'YYYY-MM' of a date in the given timezone. */
export function monthKey(d: Date, timezone: string = DEFAULT_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(d)
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  return `${y}-${m}`
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type FilesGrid = {
  months: { key: string; label: string }[]
  rows: { category: FileCategory; counts: number[] }[]
  /** Files uploaded before the first month shown. */
  older: number
}

/** Monthly count of files received per category, oldest month first, ending with the current month. */
export function buildFilesGrid(
  docs: Pick<DocumentItem, 'folderName' | 'fileName' | 'uploadedAt'>[],
  now: Date,
  monthsBack = 6,
  timezone: string = DEFAULT_TIMEZONE,
): FilesGrid {
  const [y, m] = monthKey(now, timezone).split('-').map(Number)
  const months: { key: string; label: string }[] = []
  for (let i = monthsBack - 1; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i
    const yy = Math.floor(idx / 12)
    const mm = idx % 12
    months.push({ key: `${yy}-${String(mm + 1).padStart(2, '0')}`, label: `${MONTH_NAMES[mm]} ${yy}` })
  }
  const rows = FILE_CATEGORIES.map((category) => ({ category, counts: months.map(() => 0) }))
  let older = 0
  for (const d of docs) {
    if (!d.uploadedAt) continue
    const at = new Date(d.uploadedAt)
    if (Number.isNaN(at.getTime())) continue
    const key = monthKey(at, timezone)
    const col = months.findIndex((mo) => mo.key === key)
    if (col === -1) {
      if (key < months[0].key) older++
      continue
    }
    rows.find((r) => r.category === categoriseDocument(d))!.counts[col]++
  }
  return { months, rows, older }
}

// ---------------------------------------------------------------- Health

export type HealthTone = 'good' | 'watch' | 'risk' | 'none'

export function healthTone(score: number | null | undefined): HealthTone {
  if (score === null || score === undefined) return 'none'
  if (score >= 75) return 'good'
  if (score >= 50) return 'watch'
  return 'risk'
}

/** SVG polyline points for a 0..100 series, left to right. '' when there is nothing to draw. */
export function sparklinePoints(values: number[], width: number, height: number, min = 0, max = 100): string {
  if (values.length === 0) return ''
  const span = max - min || 1
  const step = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const clamped = Math.min(max, Math.max(min, v))
      const x = values.length > 1 ? i * step : width / 2
      const y = height - ((clamped - min) / span) * height
      return `${round1(x)},${round1(y)}`
    })
    .join(' ')
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ---------------------------------------------------------------- Formatting

export function formatDelta(d: number | null | undefined): string {
  if (d === null || d === undefined) return ''
  if (d > 0) return `+${d}`
  return String(d)
}

/** "45 min", "3 h 20 min", "2 d 4 h". */
export function formatMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined) return ''
  const total = Math.max(0, Math.round(min))
  if (total < 60) return `${total} min`
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`
  return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`
}

/** "16 Nov 2026, 2:30 pm" in IST. */
export function formatDateTime(iso: string | null | undefined, timezone: string = DEFAULT_TIMEZONE): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

export function formatDate(iso: string | null | undefined, timezone: string = DEFAULT_TIMEZONE): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function formatAgo(iso: string | null | undefined, now: Date): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const min = Math.round((now.getTime() - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.floor(min / 60)} h ago`
  return `${Math.floor(min / 1440)} d ago`
}

// ---------------------------------------------------------------- Permissions (mirrors lib/data updateConversation)

/** Senior accountants and admins may change tickets; engineers and anyone viewing as are read only. */
export function canEditTickets(user: { role: string; viewingAs?: unknown }): boolean {
  if (user.viewingAs) return false
  return user.role === 'senior_accountant' || user.role === 'admin'
}

/** Why tickets are read only for this user, or null when they can change them. */
export function ticketReadOnlyNote(user: { role: string; viewingAs?: unknown }): string | null {
  if (canEditTickets(user)) return null
  if (user.viewingAs) return 'Read only while viewing as another accountant.'
  return 'Read only. Engineers can view tickets but not change them.'
}

/** Only http(s) links from stored data are rendered; anything else (javascript:, data:) becomes null. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}
