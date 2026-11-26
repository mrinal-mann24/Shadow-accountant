'use client'
// Follow-ups on the client page (promises, documents to chase, repeat asks) and the "Follow-ups due" card on Home.
// Data comes from the server page (lib/data); the browser never queries Supabase. The server action is passed in
// as a prop, so this module stays free of server imports and its pure helpers are unit tested.
// This is a client module: server code (pages, actions) may render its components but must not call its helpers
// (they would be client references there). Pass plain props instead.
import Link from 'next/link'
import { useActionState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { FollowUpAction, FollowUpKind, FollowUpView } from '@/lib/followups/types'
import { cn } from '@/lib/utils'
import { formatDateTime } from './logic'
import { EmptyState } from './ui'

// ---------------------------------------------------------------- Pure helpers (tested)

const IST_OFFSET_MS = 330 * 60_000
const DAY_MS = 86_400_000

/** Calendar day number in IST (fixed +5:30, no daylight saving). */
function istDay(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS)
}

/**
 * Due badge text in IST: "Overdue 2 days", "Overdue" (earlier today), "Due today", "Due 21 Nov"
 * ("Due 3 Jan 2027" in another year). Null or bad dates give "No due date".
 */
export function dueLabel(dueAt: string | null | undefined, now: Date): string {
  if (!dueAt) return 'No due date'
  const due = Date.parse(dueAt)
  if (Number.isNaN(due)) return 'No due date'
  const days = istDay(now.getTime()) - istDay(due)
  if (days > 0) return `Overdue ${days} ${days === 1 ? 'day' : 'days'}`
  if (days === 0) return due <= now.getTime() ? 'Overdue' : 'Due today'
  return `Due ${shortIstDate(due, now)}`
}

/** "21 Nov" in IST, or "3 Jan 2027" when the year differs from now. */
function shortIstDate(ms: number, now: Date): string {
  const sameYear =
    new Date(ms + IST_OFFSET_MS).getUTCFullYear() === new Date(now.getTime() + IST_OFFSET_MS).getUTCFullYear()
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(ms))
}

/**
 * Due badge text that knows the status: a missed item reads "Missed (due 16 Nov)" ("Missed" with no or a bad
 * date), so an escalated item stands apart from one that is only overdue. Other statuses use dueLabel.
 */
export function followUpDueLabel(f: Pick<FollowUpView, 'status' | 'dueAt'>, now: Date): string {
  if (f.status !== 'missed') return dueLabel(f.dueAt, now)
  const due = f.dueAt ? Date.parse(f.dueAt) : NaN
  return Number.isNaN(due) ? 'Missed' : `Missed (due ${shortIstDate(due, now)})`
}

export type DueTone = 'overdue' | 'today' | 'later' | 'none'

export function dueTone(dueAt: string | null | undefined, now: Date): DueTone {
  const label = dueLabel(dueAt, now)
  if (label.startsWith('Overdue')) return 'overdue'
  if (label === 'Due today') return 'today'
  if (label === 'No due date') return 'none'
  return 'later'
}

/** dueTone, with a missed item always in the overdue tone. */
export function followUpDueTone(f: Pick<FollowUpView, 'status' | 'dueAt'>, now: Date): DueTone {
  return f.status === 'missed' ? 'overdue' : dueTone(f.dueAt, now)
}

/** "42 m", "1 h 42 m", "3 h", "2 d" (at least 1 m). */
function formatSpan(minutes: number): string {
  const m = Math.max(1, Math.round(minutes))
  if (m < 60) return `${m} m`
  if (m < 1440) {
    const h = Math.floor(m / 60)
    const rest = m % 60
    return rest > 0 ? `${h} h ${rest} m` : `${h} h`
  }
  return `${Math.floor(m / 1440)} d`
}

/** "2:10 pm" when the time is today in IST, else "21 Nov". Empty for a bad date. */
function istClockOrDate(iso: string | null | undefined, now: Date): string {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return ''
  if (istDay(at) !== istDay(now.getTime())) return shortIstDate(at, now)
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(
    new Date(at),
  )
}

export type FollowUpClock = { text: string; caption: string; tone: DueTone }

/**
 * The right-hand time on a Home follow-up row: "1 h 42 m" overdue (or missed), "in 48 m" due later today,
 * "28 Nov" due on a later day. Undated items (repeat asks) show when the client asked: "2:10 pm" asked.
 */
export function followUpClock(f: Pick<FollowUpView, 'status' | 'dueAt' | 'sourceAt'>, now: Date): FollowUpClock {
  const tone = followUpDueTone(f, now)
  const due = f.dueAt ? Date.parse(f.dueAt) : NaN
  if (Number.isNaN(due)) return { text: istClockOrDate(f.sourceAt, now), caption: 'asked', tone }
  const diff = (due - now.getTime()) / 60_000
  if (diff <= 0) return { text: formatSpan(-diff), caption: f.status === 'missed' ? 'missed' : 'overdue', tone }
  if (istDay(due) === istDay(now.getTime())) return { text: `in ${formatSpan(diff)}`, caption: 'due', tone }
  return { text: shortIstDate(due, now), caption: 'due', tone }
}

/**
 * An item created more than 24 h after its source message was found while scanning old messages (the pilot's
 * 30-day backfill). It never gets alerts and is left off Home; the client page labels it "From history".
 * Same rule as isHistoryItem in lib/data/followups.ts (this module cannot import server code).
 */
const HISTORY_MS = 24 * 60 * 60_000

export function isFromHistory(f: Pick<FollowUpView, 'createdAt' | 'sourceAt'>): boolean {
  const created = Date.parse(f.createdAt)
  const source = Date.parse(f.sourceAt)
  if (Number.isNaN(created) || Number.isNaN(source)) return false
  return created - source > HISTORY_MS
}

const KIND_LABELS: Record<FollowUpKind, string> = {
  promise: 'Promise',
  document: 'Document',
  repeat_ask: 'Asked again',
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as FollowUpKind] ?? kind
}

/** Senior accountants and admins act on follow-ups; engineers and anyone viewing as are read only (same as tickets). */
export function canAct(user: { role: string; viewingAs?: unknown }): boolean {
  if (user.viewingAs) return false
  return user.role === 'senior_accountant' || user.role === 'admin'
}

export function actReadOnlyNote(user: { role: string; viewingAs?: unknown }): string | null {
  if (canAct(user)) return null
  if (user.viewingAs) return 'Read only while viewing as another accountant.'
  return 'Read only. Engineers can view follow-ups but not change them.'
}

/** Open and missed (past due, not yet delivered) items still need someone to act. */
export function isActive(f: Pick<FollowUpView, 'status'>): boolean {
  return f.status === 'open' || f.status === 'missed'
}

export type FollowUpGroups = {
  promises: FollowUpView[]
  documents: FollowUpView[]
  repeatAsks: FollowUpView[]
  closed: FollowUpView[]
}

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}

/** Splits into the three open groups (most urgent first) and the last `closedLimit` closed ones (latest first). */
export function groupFollowUps(items: FollowUpView[], closedLimit = 10): FollowUpGroups {
  const active = items.filter(isActive)
  const byDue = (a: FollowUpView, b: FollowUpView) => time(a.dueAt) - time(b.dueAt) || time(a.sourceAt) - time(b.sourceAt)
  const byAsked = (a: FollowUpView, b: FollowUpView) => time(a.sourceAt) - time(b.sourceAt)
  const closedAt = (f: FollowUpView) => {
    const t = time(f.resolvedAt ?? f.createdAt)
    return t === Number.POSITIVE_INFINITY ? 0 : t
  }
  return {
    promises: active.filter((f) => f.kind === 'promise').sort(byDue),
    documents: active.filter((f) => f.kind === 'document').sort(byAsked),
    repeatAsks: active.filter((f) => f.kind === 'repeat_ask').sort(byAsked),
    closed: items
      .filter((f) => !isActive(f))
      .sort((a, b) => closedAt(b) - closedAt(a))
      .slice(0, closedLimit),
  }
}

/** "Done", "Answered", "Not needed", "Not a repeat". */
export function closedLabel(f: Pick<FollowUpView, 'kind' | 'status'>): string {
  const repeat = f.kind === 'repeat_ask'
  if (f.status === 'done') return repeat ? 'Answered' : 'Done'
  if (f.status === 'cancelled') return repeat ? 'Not a repeat' : 'Not needed'
  if (f.status === 'missed') return 'Missed'
  return 'Open'
}

export type FollowUpActionState = { ok: boolean; error: string | null }

// ---------------------------------------------------------------- Components

type Action = (prev: FollowUpActionState, formData: FormData) => Promise<FollowUpActionState>

const TONE_CLASSES: Record<DueTone, string> = {
  overdue: 'bg-destructive-soft text-destructive',
  today: 'bg-warning-soft text-[#8A4205]',
  later: 'bg-secondary text-muted-foreground',
  none: 'bg-secondary text-muted-foreground',
}

export function DueBadge({ dueAt, now }: { dueAt: string | null; now: Date }) {
  return (
    <Badge variant="secondary" className={TONE_CLASSES[dueTone(dueAt, now)]}>
      {dueLabel(dueAt, now)}
    </Badge>
  )
}

/** Panel badge: like DueBadge, but a missed item reads "Missed (due ...)". */
function StatusDueBadge({ f, now }: { f: FollowUpView; now: Date }) {
  return (
    <Badge variant="secondary" className={TONE_CLASSES[followUpDueTone(f, now)]}>
      {followUpDueLabel(f, now)}
    </Badge>
  )
}

function RowActions({ f, action, disabled }: { f: FollowUpView; action: Action; disabled: boolean }) {
  const [state, formAction, pending] = useActionState(action, { ok: true, error: null })
  const repeat = f.kind === 'repeat_ask'
  const buttons: [FollowUpAction, string][] = repeat
    ? [
        ['done', 'Answered'],
        ['cancel', 'Not a repeat'],
      ]
    : [
        ['done', 'Done'],
        ['cancel', 'Not needed'],
        ['extend', 'Extend 1 day'],
      ]
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="id" value={f.id} />
      {buttons.map(([value, label]) => (
        <Button key={value} type="submit" name="action" value={value} variant="outline" size="xs" disabled={disabled || pending}>
          {label}
        </Button>
      ))}
      {pending && <span className="text-xs text-muted-foreground">Saving...</span>}
      {!pending && state.error && (
        <span role="status" className="text-xs text-destructive">
          {state.error}
        </span>
      )}
    </form>
  )
}

function Group({ title, children, count }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">
        {title} <span className="text-muted-foreground">({count})</span>
      </h3>
      <ul className="divide-y text-sm">{children}</ul>
    </div>
  )
}

function Row({
  f,
  meta,
  badge,
  actions,
}: {
  f: FollowUpView
  meta: string
  badge?: React.ReactNode
  actions: React.ReactNode
}) {
  return (
    <li className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-medium wrap-break-word">{f.item}</p>
        <div className="flex flex-wrap items-center gap-2">
          {isFromHistory(f) && <span className="text-xs text-muted-foreground">From history</span>}
          {badge}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{meta}</p>
      {actions}
    </li>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The client page panel. `items` null means follow-ups could not be loaded (for example the table is not there
 * yet): a quiet note, never an error. `nowIso` comes from the server so server and browser render the same labels.
 */
export function FollowUpsPanel({
  items,
  nowIso,
  action,
  user,
}: {
  items: FollowUpView[] | null
  nowIso: string
  action: Action
  /** Only what canAct needs, so no identity reaches the browser. */
  user: { role: string; viewingAs: boolean }
}) {
  if (items === null) return <EmptyState>Follow-ups are not available yet.</EmptyState>
  const now = new Date(nowIso)
  const readOnlyNote = actReadOnlyNote(user)
  const g = groupFollowUps(items)
  const openCount = g.promises.length + g.documents.length + g.repeatAsks.length
  const disabled = readOnlyNote !== null
  const actions = (f: FollowUpView) => <RowActions f={f} action={action} disabled={disabled} />

  return (
    <div className="flex flex-col gap-4">
      {readOnlyNote && openCount > 0 && <p className="text-xs text-muted-foreground">{readOnlyNote}</p>}
      {openCount === 0 ? (
        <EmptyState>No open follow-ups.</EmptyState>
      ) : (
        <>
          <Group title="Promises" count={g.promises.length}>
            {g.promises.map((f) => (
              <Row
                key={f.id}
                f={f}
                badge={<StatusDueBadge f={f} now={now} />}
                meta={`Promised by ${f.sourceSender ?? 'the team'} · ${formatDateTime(f.sourceAt)}`}
                actions={actions(f)}
              />
            ))}
          </Group>
          <Group title="Documents to chase" count={g.documents.length}>
            {g.documents.map((f) => (
              <Row
                key={f.id}
                f={f}
                meta={`Asked ${formatDateTime(f.sourceAt)} · ${plural(f.reminderCount, 'reminder', 'reminders')} sent`}
                actions={actions(f)}
              />
            ))}
          </Group>
          <Group title="Client asked again" count={g.repeatAsks.length}>
            {g.repeatAsks.map((f) => (
              <Row
                key={f.id}
                f={f}
                meta={`Asked again ${formatDateTime(f.sourceAt)}${f.sourceSender ? ` by ${f.sourceSender}` : ''}`}
                actions={actions(f)}
              />
            ))}
          </Group>
        </>
      )}
      {g.closed.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Recently closed ({g.closed.length})
          </summary>
          <ul className="mt-2 divide-y">
            {g.closed.map((f) => (
              <li key={f.id} className="py-2 first:pt-0 last:pb-0">
                <p className="wrap-break-word">{f.item}</p>
                <p className="text-xs text-muted-foreground">
                  {[
                    kindLabel(f.kind),
                    closedLabel(f),
                    f.resolvedBy ? (f.resolvedBy === 'ai' ? 'closed automatically' : `by ${f.resolvedBy}`) : null,
                    f.resolvedAt ? formatDateTime(f.resolvedAt) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** Home card body: follow-ups due across the user's clients. `items` null means not available yet. */
export function FollowUpsDueList({ items, nowIso }: { items: FollowUpView[] | null; nowIso: string }) {
  if (items === null) return <EmptyState>Follow-ups are not available yet.</EmptyState>
  if (items.length === 0) return <EmptyState>Nothing due today.</EmptyState>
  const now = new Date(nowIso)
  return (
    <ul className="-mx-5 divide-y divide-line-soft border-t border-line-soft">
      {items.map((f, i) => {
        const clock = followUpClock(f, now)
        return (
          <li key={f.id} className={cn('anim-rise', DELAYS[Math.min(i, DELAYS.length - 1)])}>
            <Link
              href={`/clients/${encodeURIComponent(f.clientId)}#follow-ups`}
              title={followUpDueLabel(f, now)}
              className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-[#F8F9FB]"
            >
              <span className={cn('size-2.5 rounded-full', DOT_CLASSES[clock.tone], clock.tone === 'overdue' && 'live-red')} aria-hidden />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm font-semibold">{f.clientName}</strong>
                  <span className={cn('rounded-md px-2 py-0.5 text-xs', PILL_CLASSES[clock.tone])}>
                    {f.status === 'missed' ? `${kindLabel(f.kind)} missed` : kindLabel(f.kind)}
                  </span>
                  {f.sourceSender && <span className="text-xs text-muted-foreground">{f.sourceSender}</span>}
                </div>
                <span className="truncate text-[13px] text-muted-foreground">{f.item}</span>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className={cn('font-mono text-[13px] whitespace-nowrap tabular-nums', CLOCK_CLASSES[clock.tone])}>{clock.text}</span>
                <span className="text-xs text-muted-foreground">{clock.caption}</span>
              </div>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

const DELAYS = ['anim-d1', 'anim-d2', 'anim-d3', 'anim-d4', 'anim-d5', 'anim-d6', 'anim-d7', 'anim-d8']

const DOT_CLASSES: Record<DueTone, string> = {
  overdue: 'bg-destructive',
  today: 'bg-warning',
  later: 'bg-border',
  none: 'bg-border',
}

const PILL_CLASSES: Record<DueTone, string> = {
  overdue: 'bg-destructive-soft text-destructive',
  today: 'bg-warning-soft text-[#8A4205]',
  later: 'bg-secondary text-muted-foreground',
  none: 'bg-secondary text-muted-foreground',
}

const CLOCK_CLASSES: Record<DueTone, string> = {
  overdue: 'text-destructive',
  today: 'text-[#8A4205]',
  later: 'text-muted-foreground',
  none: 'text-muted-foreground',
}
