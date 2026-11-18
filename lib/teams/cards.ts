// Adaptive Cards for the Shadow Teams bot (ticket, reminder, escalation, files, help) and the parser for card
// clicks. Pure: no I/O, safe to unit test. Client text (client name, title, summary, file names, notes) is masked
// with maskCredentials (CLAUDE.md: never echo client credentials), made plain with plainText (TextBlocks render
// markdown, so client text must never become a link or an image), then clipped.
import { z } from 'zod'
import { maskCredentials } from '@/lib/ai/redact'
import { isTag, TAG_LABELS } from '@/components/accountant/ticket-intent'
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
  return card(body, [openUrl('Open client', clientUrl(o.siteUrl, o.clientId))])
}

/** What the bot does and the commands it understands. */
export function helpCard(o: { siteUrl: string }): AdaptiveCard {
  return card(
    [
      heading('Shadow Accountant in Teams'),
      text(
        'I post new tickets, reminders when a client is waiting, escalations and new client files to your channels. ' +
          'Use the buttons on a card to start, close or reassign a ticket.',
      ),
      text('Commands', { weight: 'Bolder', spacing: 'Medium' }),
      facts([
        ['link <accountant email>', 'Post this accountant’s tickets to this channel (Admin or Engineer, typed in the channel)'],
        ['link escalations', 'Post escalations to this channel (Admin or Engineer, typed in the channel)'],
        ['unlink', 'Stop posting to this channel'],
        ['channels', 'Show which channels are linked'],
        ['help', 'Show this card'],
      ]),
      text('Ask any question about your clients and I will answer with sources.', { spacing: 'Medium' }),
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
