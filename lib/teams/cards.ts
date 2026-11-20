// Adaptive Cards for the Shadow Teams bot (ticket, reminder, escalation, files, help) and the parser for card
// clicks. Pure: no I/O, safe to unit test. Client text (client name, title, summary, file names, notes) is masked
// with maskCredentials (CLAUDE.md: never echo client credentials), made plain with plainText (TextBlocks render
// markdown, so client text must never become a link or an image), then clipped.
import { z } from 'zod'
import { maskCredentials } from '@/lib/ai/redact'
import { isTag, TAG_LABELS } from '@/components/accountant/ticket-intent'
import type { FollowUpAction, FollowUpCardData, FollowUpView } from '@/lib/followups/types'
import type {
  AdaptiveCard,
  CardActionData,
  CardActionName,
  CardHandled,
  NotificationAction,
  NotificationKind,
  OutgoingActivity,
  TicketForCard,
} from './types'

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json'
const VERSION = '1.5'
const VERB = 'ticket'
export const MAX_TITLE = 120
export const MAX_SUMMARY = 600
export const MAX_FILES = 10

const HANDLED_LABELS: Record<NotificationAction, string> = {
  started: 'Started',
  closed: 'Closed',
  not_ticket: 'Marked not a ticket',
  reassigned: 'Reassigned',
  pinged: 'Accountant pinged',
}

// ---------------------------------------------------------------- formatting helpers

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/** '18 Nov, 3:45 pm' in IST. Empty string for a missing or invalid time. */
export function formatIst(at: string | null | undefined): string {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const p: Record<string, string> = {}
  for (const part of IST.formatToParts(d)) p[part.type] = part.value
  return `${p.day} ${p.month}, ${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toLowerCase()}`.trim()
}

/** 135 -> '2 h 15 min', 45 -> '45 min', 120 -> '2 h'. */
export function formatWaiting(minutes: number): string {
  const m = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest} min`
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}

function clip(text: string, max: number): string {
  const s = text.trim()
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

const ZWSP = '\u200B'
const MD_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g
const MD_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g
/** Markdown link / emphasis characters, plus the backslash itself so a client "\*" cannot undo an escape. */
const MD_SPECIAL = /[\\[\]()*_`#>~]/g

/**
 * Client text as plain text for a markdown TextBlock: images are removed, [text](url) becomes text, the
 * remaining markdown characters are escaped with a backslash, and bare URLs get a zero-width space after
 * "http" / "www" so Teams does not turn them into links.
 */
export function plainText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(MD_IMAGE, '')
    .replace(MD_LINK, '$1')
    .replace(MD_SPECIAL, (c) => `\\${c}`)
    .replace(/(http)(?=s?:)/gi, `$1${ZWSP}`)
    .replace(/\b(www)\./gi, `$1${ZWSP}.`)
}

/** Mask, then make plain, then clip, so a clip can never cut a credential in half and leave part of it visible. */
function safe(text: string | null | undefined, max: number): string {
  return clip(plainText(maskCredentials(text ?? '')), max)
}

function tagLabel(tag: string | null): string {
  if (!tag) return 'None'
  return isTag(tag) ? TAG_LABELS[tag] : plainText(tag)
}

function base(url: string): string {
  return url.replace(/\/+$/, '')
}

export function clientUrl(siteUrl: string, clientId: string): string {
  return `${base(siteUrl)}/clients/${encodeURIComponent(clientId)}`
}

export function ticketUrl(siteUrl: string, clientId: string, ticketId: string): string {
  return `${clientUrl(siteUrl, clientId)}#ticket-${encodeURIComponent(ticketId)}`
}

// ---------------------------------------------------------------- building blocks

function card(body: unknown[], actions: unknown[]): AdaptiveCard {
  return { type: 'AdaptiveCard', $schema: SCHEMA, version: VERSION, msteams: { width: 'Full' }, body, actions }
}

function text(value: string, extra: Record<string, unknown> = {}) {
  return { type: 'TextBlock', text: value, wrap: true, ...extra }
}

function heading(value: string) {
  return text(value, { size: 'Medium', weight: 'Bolder' })
}

function facts(list: [string, string][]) {
  return { type: 'FactSet', facts: list.filter(([, v]) => v).map(([title, value]) => ({ title, value })) }
}

function execute(
  title: string,
  action: CardActionName,
  t: TicketForCard,
  kind: NotificationKind,
  ref: string,
  extra: Record<string, unknown> = {},
) {
  const data: CardActionData = { action, ticketId: t.id, kind, ref }
  return { type: 'Action.Execute', title, verb: VERB, data, ...extra }
}

function openUrl(title: string, url: string) {
  return { type: 'Action.OpenUrl', title, url }
}

function handledBlocks(h: CardHandled): unknown[] {
  const by = clip(plainText(h.by || 'someone'), 80)
  const when = formatIst(h.at)
  const line = `${HANDLED_LABELS[h.action] ?? 'Updated'} by ${by}${when ? `, ${when}` : ''}`
  const out: unknown[] = [text(line, { weight: 'Bolder', separator: true, spacing: 'Medium' })]
  if (h.note) out.push(text(safe(h.note, 300), { isSubtle: true }))
  return out
}

function ticketBody(t: TicketForCard, headingText: string, extraFacts: [string, string][] = []): unknown[] {
  const body: unknown[] = [heading(headingText)]
  const title = safe(t.title, MAX_TITLE)
  if (title) body.push(text(title, { weight: 'Bolder' }))
  const summary = safe(t.summary, MAX_SUMMARY)
  if (summary) body.push(text(summary))
  body.push(
    facts([
      ['Tag', tagLabel(t.tag)],
      ['Opened', formatIst(t.openedAt)],
      ...extraFacts,
      ['Accountant', plainText(t.vaName?.trim()) || 'Not assigned'],
    ]),
  )
  return body
}

// ---------------------------------------------------------------- cards

/** New ticket card, posted to the accountant's channel. */
export function ticketCard(t: TicketForCard, o: { siteUrl: string; handled?: CardHandled }): AdaptiveCard {
  const body = ticketBody(t, `New ticket: ${safe(t.clientName, 120)}`)
  const open = openUrl('Open in Shadow', ticketUrl(o.siteUrl, t.clientId, t.id))
  if (o.handled) return card([...body, ...handledBlocks(o.handled)], [open])
  return card(body, [
    execute('Start', 'start', t, 'ticket', t.id, { style: 'positive' }),
    execute('Close', 'close', t, 'ticket', t.id),
    execute('Not a ticket', 'not_ticket', t, 'ticket', t.id),
    open,
  ])
}

/** Reminder when the client has been waiting for a reply (business hours). */
export function reminderCard(
  t: TicketForCard,
  o: { siteUrl: string; waitingMinutes: number; ref: string; handled?: CardHandled },
): AdaptiveCard {
  const body = ticketBody(t, `Client waiting ${formatWaiting(o.waitingMinutes)} (business hours)`, [
    ['Client', safe(t.clientName, 120)],
    ['Last message', formatIst(t.lastMessageAt)],
  ])
  const open = openUrl('Open in Shadow', ticketUrl(o.siteUrl, t.clientId, t.id))
  if (o.handled) return card([...body, ...handledBlocks(o.handled)], [open])
  return card(body, [
    execute('Start', 'start', t, 'reminder', o.ref, { style: 'positive' }),
    execute('Close', 'close', t, 'reminder', o.ref),
    open,
  ])
}

/** Escalation card for the Escalations channel, with a picker to reassign the ticket. */
export function escalationCard(
  t: TicketForCard,
  o: {
    siteUrl: string
    waitingMinutes: number
    ref: string
    accountants: { vaId: string; name: string }[]
    handled?: CardHandled
  },
): AdaptiveCard {
  const body = ticketBody(
    t,
    `Escalation: ${safe(t.clientName, 120)} waiting ${formatWaiting(o.waitingMinutes)}`,
    [['Last message', formatIst(t.lastMessageAt)]],
  )
  const open = openUrl('Open in Shadow', ticketUrl(o.siteUrl, t.clientId, t.id))
  // A ping does not resolve the escalation: keep the picker and buttons, with the ping shown as a note above them.
  if (o.handled && o.handled.action !== 'pinged') return card([...body, ...handledBlocks(o.handled)], [open])
  const note = o.handled ? handledBlocks(o.handled) : []
  const choices = o.accountants.map((a) => ({ title: clip(a.name || a.vaId, 80), value: a.vaId }))
  const picker: Record<string, unknown> = {
    type: 'Input.ChoiceSet',
    id: 'vaId',
    style: 'compact',
    placeholder: 'Reassign to',
    choices,
  }
  if (t.vaId && choices.some((c) => c.value === t.vaId)) picker.value = t.vaId
  return card(
    [...body, ...note, picker],
    [
      execute('Reassign', 'reassign', t, 'escalation', o.ref, { style: 'positive', associatedInputs: 'auto' }),
      execute('Ping accountant', 'ping', t, 'escalation', o.ref, { associatedInputs: 'none' }),
      open,
    ],
  )
}

/** New files from a client. Links only, no Execute buttons. */
export function filesCard(o: {
  clientId: string
  clientName: string
  files: { name: string; at: string }[]
  siteUrl: string
}): AdaptiveCard {
  const n = o.files.length
  const body: unknown[] = [heading(`${n} new ${n === 1 ? 'file' : 'files'} from ${safe(o.clientName, 120)}`)]
  const shown = o.files.slice(0, MAX_FILES)
  if (shown.length)
    body.push(facts(shown.map((f) => [safe(f.name, 120) || 'Unnamed file', formatIst(f.at) || ' '] as [string, string])))
  if (n > MAX_FILES) body.push(text(`+ ${n - MAX_FILES} more`, { isSubtle: true }))
  // Opens the client's files in Shadow, where each file has "Open in NEO" (it runs in the browser on this laptop).
  return card(body, [openUrl('Open files in Shadow', `${clientUrl(o.siteUrl, o.clientId)}#files`)])
}

/** What the bot does and the commands it understands. */
export function helpCard(o: { siteUrl: string }): AdaptiveCard {
  return card(
    [
      heading('Shadow Accountant in Teams'),
      text(
        'I send you everything here, in this chat: new tickets, reminders when a client is waiting, client files and ' +
          'follow-ups for your clients (Senior Accountants), and escalations (Admins). Use the buttons on a card to ' +
          'start, close or reassign a ticket.',
      ),
      text('In this chat', { weight: 'Bolder', spacing: 'Medium' }),
      facts([
        ['Ask', 'Anything about your clients, for example "open tickets for Puneeth\'s clients". Answers come with sources.'],
        ['General', 'Accounting, GST or Tally questions, or help drafting a message.'],
        ['Save', 'Paste a call transcript or meeting notes and say "save this for <client>". Press Save on the card to store it.'],
        ['new chat', 'Forget our earlier messages and start fresh'],
        ['help', 'Show this card'],
      ]),
      text('Team channels (optional, Admin or Engineer, typed in the channel)', { weight: 'Bolder', spacing: 'Medium' }),
      facts([
        ['link <accountant email>', 'Also post this accountant’s tickets to this channel, for anyone who has not opened this chat'],
        ['link escalations', 'Post escalations here when no Admin has opened this chat'],
        ['unlink', 'Stop posting to this channel'],
        ['channels', 'Show which channels are linked'],
      ]),
    ],
    [openUrl('Open Shadow', base(o.siteUrl))],
  )
}

/** Wraps a card as a message with one Adaptive Card attachment. */
export function cardAttachment(c: AdaptiveCard): OutgoingActivity {
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: c }] }
}

// ---------------------------------------------------------------- clicks

const id = z.string().trim().min(1).max(200)

const actionSchema = z.object({
  action: z.object({
    type: z.literal('Action.Execute'),
    verb: z.literal(VERB),
    data: z.object({
      action: z.enum(['start', 'close', 'not_ticket', 'reassign', 'ping']),
      ticketId: id,
      kind: z.enum(['ticket', 'reminder', 'escalation', 'files']),
      ref: id,
      // From the 'vaId' ChoiceSet; an empty pick arrives as ''.
      vaId: z.string().trim().max(200).optional(),
    }),
  }),
})

/** The data of an adaptiveCard/action invoke from one of our cards, or null when the value is anything else. */
export function parseCardAction(value: unknown): CardActionData | null {
  const r = actionSchema.safeParse(value)
  if (!r.success) return null
  const { vaId, ...rest } = r.data.action.data
  return vaId ? { ...rest, vaId } : rest
}

// ---------------------------------------------------------------- follow-ups

const FOLLOW_UP_VERB = 'followup'
export const MAX_ITEM = 300

export type FollowUpWhat = 'due' | 'missed' | 'chase' | 'repeat'
export type FollowUpHandled = { action: 'done' | 'cancelled' | 'extended'; by: string; at: string; note?: string }

const FOLLOW_UP_REF_REST = /^(due|missed|chase|repeat):(\d{1,6})$/

/** The what and n of a follow-up ref 'fu:<id>:<what>:<n>' for this id, or null when it is not one. */
export function followUpRefParts(ref: string, followUpId: string): { what: FollowUpWhat; n: number } | null {
  const prefix = `fu:${followUpId}:`
  if (!ref.startsWith(prefix)) return null
  const m = FOLLOW_UP_REF_REST.exec(ref.slice(prefix.length))
  return m ? { what: m[1] as FollowUpWhat, n: Number(m[2]) } : null
}

export function followUpsUrl(siteUrl: string, clientId: string): string {
  return `${clientUrl(siteUrl, clientId)}#follow-ups`
}

/** 90 -> '1 h 30 min ago', 3 days -> '3 days ago'. */
function timeAgo(at: string, now: Date): string {
  const t = Date.parse(at)
  if (Number.isNaN(t)) return ''
  const minutes = Math.max(0, Math.floor((now.getTime() - t) / 60_000))
  const days = Math.floor(minutes / 1440)
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return `${formatWaiting(minutes)} ago`
}

function followUpHeading(v: FollowUpView, what: FollowUpWhat, client: string): string {
  switch (what) {
    case 'due':
      return `Promise due today: ${client}`
    case 'missed':
      return v.kind === 'document' ? `Document still not received: ${client}` : `Promise missed: ${client}`
    case 'chase':
      return `Chase document: ${client}`
    case 'repeat':
      return `Client asked again: ${client}`
  }
}

function followUpHandledLabel(v: FollowUpView, action: FollowUpHandled['action']): string {
  const repeat = v.kind === 'repeat_ask'
  if (action === 'done') return repeat ? 'Marked answered' : 'Marked done'
  if (action === 'cancelled') return repeat ? 'Marked not a repeat' : 'Marked not needed'
  return 'Extended by 1 day'
}

/**
 * A follow-up alert: promise due today, promise missed / document still not received, document chase, or a
 * client asking again. `ref` is the teams_notifications ref_id (followUpRef); `kind` is that row's kind, by
 * default 'escalation' for missed and repeat (posted to Escalations) and 'reminder' for due and chase.
 * For a chase, n in the ref is the reminder number (1 based); when it is 0 the stored reminder count is used.
 */
export function followUpCard(
  v: FollowUpView,
  o: {
    siteUrl: string
    what: FollowUpWhat
    ref: string
    kind?: 'reminder' | 'escalation'
    handled?: FollowUpHandled
    now?: Date
  },
): AdaptiveCard {
  const kind = o.kind ?? (o.what === 'missed' || o.what === 'repeat' ? 'escalation' : 'reminder')
  const body: unknown[] = [heading(followUpHeading(v, o.what, safe(v.clientName, 120)))]
  const item = safe(v.item, MAX_ITEM)
  if (item) body.push(text(item, { weight: 'Bolder' }))
  if (o.what === 'chase') {
    const ago = timeAgo(v.sourceAt, o.now ?? new Date())
    // Cycle-aware chase refs are cycle * 10 + k (k = reminder 1..3), so a new cycle after Extend gets new refs.
    const raw = followUpRefParts(o.ref, v.id)?.n ?? 0
    const refN = raw >= 10 ? raw % 10 : raw
    const n = refN > 0 ? refN : Math.max(1, v.reminderCount)
    body.push(text(`${ago ? `Asked ${ago}, ` : ''}reminder ${n}`, { isSubtle: true }))
  }
  body.push(
    facts([
      ['Due', formatIst(v.dueAt)],
      ['Accountant', plainText(v.vaName?.trim()) || 'Not assigned'],
      ['From', safe(v.sourceSender, 80)],
      ['Message time', formatIst(v.sourceAt)],
    ]),
  )
  const open = openUrl('Open in Shadow', followUpsUrl(o.siteUrl, v.clientId))
  if (o.handled) {
    const h = o.handled
    const by = clip(plainText(h.by || 'someone'), 80)
    const when = formatIst(h.at)
    body.push(text(`${followUpHandledLabel(v, h.action)} by ${by}${when ? `, ${when}` : ''}`, { weight: 'Bolder', separator: true, spacing: 'Medium' }))
    if (h.note) body.push(text(safe(h.note, 300), { isSubtle: true }))
    return card(body, [open])
  }
  const button = (title: string, action: FollowUpAction, extra: Record<string, unknown> = {}) => {
    const data: FollowUpCardData = { action, followUpId: v.id, kind, ref: o.ref }
    return { type: 'Action.Execute', title, verb: FOLLOW_UP_VERB, data, ...extra }
  }
  const buttons =
    v.kind === 'repeat_ask'
      ? [button('Answered', 'done', { style: 'positive' }), button('Not a repeat', 'cancel')]
      : [button('Done', 'done', { style: 'positive' }), button('Not needed', 'cancel'), button('Extend 1 day', 'extend')]
  return card(body, [...buttons, open])
}

const followUpSchema = z.object({
  action: z.object({
    type: z.literal('Action.Execute'),
    verb: z.literal(FOLLOW_UP_VERB),
    data: z.object({
      action: z.enum(['done', 'cancel', 'extend']),
      followUpId: id,
      kind: z.enum(['reminder', 'escalation']),
      ref: id,
    }),
  }),
})

// ---------------------------------------------------------------- save card (Teams 1:1 chat)

export const SAVE_VERB = 'save'
const SAVE_PREVIEW = 400

export type SaveCardView = {
  pendingId: string
  clientId: string
  clientName: string
  title: string
  meetingDate: string | null
  content: string
}

export type SaveHandled = { action: 'saved' | 'cancelled'; by: string; at: string; note?: string }

/** "Save to <client>?" with a preview of the text and Save / Cancel. After a click it shows who did what instead. */
export function saveCard(v: SaveCardView, o: { siteUrl: string; handled?: SaveHandled }): AdaptiveCard {
  const lines = v.content.split('\n').length
  const body: unknown[] = [
    heading(`Save to ${safe(v.clientName, MAX_TITLE)}?`),
    facts([
      ['Title', safe(v.title, MAX_TITLE)],
      ['Meeting day', v.meetingDate ? formatDay(v.meetingDate) : 'Today'],
      ['Size', `${v.content.length.toLocaleString('en-IN')} characters, ${lines} lines`],
    ]),
    text(safe(v.content, SAVE_PREVIEW), { isSubtle: true, spacing: 'Medium' }),
  ]
  const open = openUrl('Open client', clientUrl(o.siteUrl, v.clientId))
  if (o.handled) {
    const by = clip(plainText(o.handled.by || 'someone'), 80)
    const when = formatIst(o.handled.at)
    const label = o.handled.action === 'saved' ? `Saved to ${safe(v.clientName, MAX_TITLE)} by ${by}` : `Cancelled by ${by}`
    body.push(text(`${label}${when ? `, ${when}` : ''}`, { weight: 'Bolder', separator: true, spacing: 'Medium' }))
    if (o.handled.note) body.push(text(safe(o.handled.note, 300), { isSubtle: true }))
    return card(body, o.handled.action === 'saved' ? [open] : [])
  }
  body.push(text('Nothing is saved until you press Save. Passwords and OTPs are masked.', { isSubtle: true, size: 'Small' }))
  const button = (title: string, action: 'save' | 'cancel', extra: Record<string, unknown> = {}) => ({
    type: 'Action.Execute',
    title,
    verb: SAVE_VERB,
    data: { action, pendingId: v.pendingId },
    ...extra,
  })
  return card(body, [button('Save', 'save', { style: 'positive' }), button('Cancel', 'cancel')])
}

const DAY = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })

/** '18 Nov 2026' for a YYYY-MM-DD date (no time zone shift). */
function formatDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? ymd : DAY.format(d)
}

const saveSchema = z.object({
  action: z.object({
    type: z.literal('Action.Execute'),
    verb: z.literal(SAVE_VERB),
    data: z.object({ action: z.enum(['save', 'cancel']), pendingId: id }),
  }),
})

/** The data of a Save card click, or null for anything else. */
export function parseSaveAction(value: unknown): { action: 'save' | 'cancel'; pendingId: string } | null {
  const r = saveSchema.safeParse(value)
  return r.success ? r.data.action.data : null
}

/** The data of a follow-up card click, or null for anything else (another verb, or a ref of another follow-up). */
export function parseFollowUpAction(value: unknown): FollowUpCardData | null {
  const r = followUpSchema.safeParse(value)
  if (!r.success) return null
  const { action, followUpId, kind, ref } = r.data.action.data
  if (!followUpRefParts(ref, followUpId)) return null
  return { action, followUpId, kind, ref }
}
