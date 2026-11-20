import { describe, expect, it } from 'vitest'
import {
  cardAttachment,
  escalationCard,
  filesCard,
  followUpCard,
  followUpRefParts,
  formatIst,
  formatWaiting,
  helpCard,
  MAX_SUMMARY,
  MAX_TITLE,
  parseCardAction,
  parseFollowUpAction,
  plainText,
  reminderCard,
  ticketCard,
} from './cards'
import { followUpRef, type FollowUpView } from '@/lib/followups/types'
import type { AdaptiveCard, TicketForCard } from './types'

const SITE = 'https://shadow.example.com/'
const ticket: TicketForCard = {
  id: 't-1',
  clientId: 'c-9',
  clientName: 'Acme Traders',
  title: 'GST filing query',
  summary: 'Client asks about GSTR-3B for October.',
  tag: 'complaint',
  status: 'open',
  openedAt: '2026-11-18T10:15:00Z', // 3:45 pm IST
  lastMessageAt: '2026-11-18T10:15:00Z',
  lastMessageDirection: 'incoming',
  vaId: 'va-2',
  vaName: 'Harshit Jain',
  slaBreached: false,
}

type Action = { type: string; title: string; verb?: string; data?: Record<string, unknown>; url?: string }
const actions = (c: AdaptiveCard) => (c.actions ?? []) as Action[]
const executes = (c: AdaptiveCard) => actions(c).filter((a) => a.type === 'Action.Execute')
const openUrls = (c: AdaptiveCard) => actions(c).filter((a) => a.type === 'Action.OpenUrl')
const json = (c: AdaptiveCard) => JSON.stringify(c)
const textsOf = (c: AdaptiveCard) =>
  (c.body as { type: string; text?: string }[]).filter((b) => b.type === 'TextBlock').map((b) => b.text!)
const TICKET_LINK = 'https://shadow.example.com/clients/c-9#ticket-t-1'

describe('format helpers', () => {
  it('shows IST time like 18 Nov, 3:45 pm', () => {
    expect(formatIst('2026-11-18T10:15:00Z')).toBe('18 Nov, 3:45 pm')
    expect(formatIst('not a date')).toBe('')
  })
  it('formats waiting time', () => {
    expect(formatWaiting(45)).toBe('45 min')
    expect(formatWaiting(120)).toBe('2 h')
    expect(formatWaiting(135)).toBe('2 h 15 min')
  })
})

describe('ticketCard', () => {
  const c = ticketCard(ticket, { siteUrl: SITE })

  it('is an Adaptive Card 1.5, full width', () => {
    expect(c.type).toBe('AdaptiveCard')
    expect(c.version).toBe('1.5')
    expect(c.$schema).toBe('http://adaptivecards.io/schemas/adaptive-card.json')
    expect(c.msteams).toEqual({ width: 'Full' })
  })

  it('has the heading, tag label, opened time and accountant', () => {
    const s = json(c)
    expect(s).toContain('New ticket: Acme Traders')
    expect(s).toContain('Complaint')
    expect(s).toContain('18 Nov, 3:45 pm')
    expect(s).toContain('Harshit Jain')
  })

  it('has Start, Close, Not a ticket with correct data and an Open in Shadow link', () => {
    const ex = executes(c)
    expect(ex.map((a) => a.title)).toEqual(['Start', 'Close', 'Not a ticket'])
    expect(ex.map((a) => a.data)).toEqual([
      { action: 'start', ticketId: 't-1', kind: 'ticket', ref: 't-1' },
      { action: 'close', ticketId: 't-1', kind: 'ticket', ref: 't-1' },
      { action: 'not_ticket', ticketId: 't-1', kind: 'ticket', ref: 't-1' },
    ])
    for (const a of ex) expect(a.verb).toBe('ticket')
    expect(openUrls(c)).toEqual([{ type: 'Action.OpenUrl', title: 'Open in Shadow', url: TICKET_LINK }])
  })

  it('masks credentials in title and summary', () => {
    const s = json(
      ticketCard(
        { ...ticket, title: 'GST portal password: abc123', summary: 'Client shared password: abc123 and OTP is 445566' },
        { siteUrl: SITE },
      ),
    )
    expect(s).not.toContain('abc123')
    expect(s).not.toContain('445566')
    // [hidden] is escaped like any other bracket, so it can never be part of a link.
    expect(s).toContain('hidden')
  })

  it('clips title to 120 and summary to 600 characters', () => {
    const c2 = ticketCard({ ...ticket, title: 'T'.repeat(500), summary: 'S'.repeat(2000) }, { siteUrl: SITE })
    const texts = (c2.body as { type: string; text?: string }[]).filter((b) => b.type === 'TextBlock').map((b) => b.text!)
    const title = texts.find((t) => t.startsWith('T'))!
    const summary = texts.find((t) => t.startsWith('S'))!
    expect(title.length).toBe(MAX_TITLE)
    expect(summary.length).toBe(MAX_SUMMARY)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('handled state replaces the buttons with who did what and keeps the link', () => {
    const h = ticketCard(ticket, {
      siteUrl: SITE,
      handled: { action: 'closed', by: 'Harshit Jain', at: '2026-11-18T10:15:00Z', note: 'password: abc123' },
    })
    expect(executes(h)).toHaveLength(0)
    expect(openUrls(h).map((a) => a.url)).toEqual([TICKET_LINK])
    const s = json(h)
    expect(s).toContain('Closed by Harshit Jain, 18 Nov, 3:45 pm')
    expect(s).not.toContain('abc123')
  })
})

describe('reminderCard', () => {
  it('shows waiting time and carries kind reminder and the ref', () => {
    const c = reminderCard(ticket, { siteUrl: SITE, waitingMinutes: 135, ref: 'r-77' })
    expect(json(c)).toContain('Client waiting 2 h 15 min (business hours)')
    expect(executes(c).map((a) => a.data)).toEqual([
      { action: 'start', ticketId: 't-1', kind: 'reminder', ref: 'r-77' },
      { action: 'close', ticketId: 't-1', kind: 'reminder', ref: 'r-77' },
    ])
    expect(openUrls(c)[0].url).toBe(TICKET_LINK)
  })
})

describe('escalationCard', () => {
  const accountants = [
    { vaId: 'va-1', name: 'Priya Shah' },
    { vaId: 'va-2', name: 'Harshit Jain' },
  ]
  const c = escalationCard(ticket, { siteUrl: SITE, waitingMinutes: 240, ref: 'e-5', accountants })
  const picker = (c.body as Record<string, unknown>[]).find((b) => b.type === 'Input.ChoiceSet')!

  it('has the heading and a compact Reassign to picker defaulting to the current accountant', () => {
    expect(json(c)).toContain('Escalation: Acme Traders waiting 4 h')
    expect(picker).toMatchObject({ id: 'vaId', style: 'compact', placeholder: 'Reassign to', value: 'va-2' })
    expect(picker.choices).toEqual([
      { title: 'Priya Shah', value: 'va-1' },
      { title: 'Harshit Jain', value: 'va-2' },
    ])
  })

  it('omits the default when the current accountant is not in the list', () => {
    const c2 = escalationCard({ ...ticket, vaId: 'va-x' }, { siteUrl: SITE, waitingMinutes: 60, ref: 'e-5', accountants })
    const p2 = (c2.body as Record<string, unknown>[]).find((b) => b.type === 'Input.ChoiceSet')!
    expect(p2.value).toBeUndefined()
  })

  it('has Reassign and Ping accountant with kind escalation', () => {
    expect(executes(c).map((a) => [a.title, a.data])).toEqual([
      ['Reassign', { action: 'reassign', ticketId: 't-1', kind: 'escalation', ref: 'e-5' }],
      ['Ping accountant', { action: 'ping', ticketId: 't-1', kind: 'escalation', ref: 'e-5' }],
    ])
    expect(openUrls(c)[0].url).toBe(TICKET_LINK)
  })

  it('a ping keeps the picker and buttons, with the ping shown as a note above them', () => {
    const h = escalationCard(ticket, {
      siteUrl: SITE,
      waitingMinutes: 240,
      ref: 'e-5',
      accountants,
      handled: { action: 'pinged', by: 'Admin User', at: '2026-11-18T10:15:00Z' },
    })
    expect(executes(h).map((a) => a.title)).toEqual(['Reassign', 'Ping accountant'])
    const body = h.body as Record<string, unknown>[]
    const pickerAt = body.findIndex((b) => b.type === 'Input.ChoiceSet')
    const noteAt = body.findIndex((b) => String(b.text ?? '').startsWith('Accountant pinged by Admin User'))
    expect(pickerAt).toBeGreaterThan(-1)
    expect(noteAt).toBeGreaterThan(-1)
    expect(noteAt).toBeLessThan(pickerAt)
  })

  it('handled hides buttons and the picker', () => {
    const h = escalationCard(ticket, {
      siteUrl: SITE,
      waitingMinutes: 240,
      ref: 'e-5',
      accountants,
      handled: { action: 'reassigned', by: 'Admin User', at: '2026-11-18T10:15:00Z', note: 'Now with Priya Shah' },
    })
    expect(executes(h)).toHaveLength(0)
    expect((h.body as Record<string, unknown>[]).some((b) => b.type === 'Input.ChoiceSet')).toBe(false)
    expect(json(h)).toContain('Reassigned by Admin User')
    expect(json(h)).toContain('Now with Priya Shah')
  })
})

describe('filesCard', () => {
  it('lists up to 10 files with + n more and only an Open client link', () => {
    const files = Array.from({ length: 13 }, (_, i) => ({ id: `u-${i + 1}`, name: `invoice-${i + 1}.pdf`, at: '2026-11-18T10:15:00Z' }))
    const c = filesCard({ clientId: 'c-9', clientName: 'Acme Traders', files, siteUrl: SITE })
    const s = json(c)
    expect(s).toContain('13 new files from Acme Traders')
    expect(s).toContain('invoice-10.pdf')
    expect(s).not.toContain('invoice-11.pdf')
    expect(s).toContain('+ 3 more')
    expect(executes(c)).toHaveLength(0)
    expect(openUrls(c)).toEqual([
      { type: 'Action.OpenUrl', title: 'Open files in Shadow', url: 'https://shadow.example.com/clients/c-9#files' },
    ])
  })

  it('gives each shown file a View button that opens Shadow on that file', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ id: `u ${i + 1}`, name: `f-${i + 1}.pdf`, at: '' }))
    const s = JSON.stringify(filesCard({ clientId: 'c-9', clientName: 'Acme', files, siteUrl: SITE }).body)
    const views = [...s.matchAll(/"title":"View","url":"([^"]+)"/g)].map((m) => m[1])
    expect(views).toHaveLength(10)
    expect(views[0]).toBe('https://shadow.example.com/clients/c-9?file=u%201#file-u%201')
    expect(s).not.toContain('file=u%2011')
  })

  it('uses the singular for one file', () => {
    const c = filesCard({ clientId: 'c-9', clientName: 'Acme', files: [{ id: 'u-1', name: 'a.pdf', at: '' }], siteUrl: SITE })
    expect(json(c)).toContain('1 new file from Acme')
    expect(json(c)).not.toContain('more')
  })
})

describe('plainText (client text never becomes a link or an image)', () => {
  const ZWSP = '\u200B'

  it('removes images and keeps only the text of links', () => {
    expect(plainText('see ![x](https://evil.test/p.png) now')).toBe('see  now')
    expect(plainText('[Pay here](https://evil.test/pay)')).toBe('Pay here')
  })

  it('escapes markdown characters with a backslash', () => {
    expect(plainText('**bold** _it_ `code` # h > q ~s~ (x) [y]')).toBe(
      '\\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\# h \\> q \\~s\\~ \\(x\\) \\[y\\]',
    )
    expect(plainText('a\\*b')).toBe('a\\\\\\*b')
  })

  it('breaks bare URLs with a zero-width space', () => {
    expect(plainText('go to https://evil.test or www.evil.test')).toBe(`go to http${ZWSP}s://evil.test or www${ZWSP}.evil.test`)
    expect(plainText('HTTP://x.test')).toBe(`HTTP${ZWSP}://x.test`)
  })

  it('leaves ordinary text alone', () => {
    expect(plainText('GSTR-3B for October, Rs 1,200.50')).toBe('GSTR-3B for October, Rs 1,200.50')
    expect(plainText(null)).toBe('')
  })

  it('applies to client name, title, summary, file names and notes on every card', () => {
    const evil: TicketForCard = {
      ...ticket,
      clientName: '[Acme](https://evil.test/a)',
      title: '![t](https://evil.test/t.png)Title',
      summary: 'Click [here](https://evil.test/s) or https://evil.test/raw',
    }
    const cards = [
      ticketCard(evil, { siteUrl: SITE }),
      reminderCard(evil, { siteUrl: SITE, waitingMinutes: 60, ref: 'r' }),
      escalationCard(evil, { siteUrl: SITE, waitingMinutes: 120, ref: 'e', accountants: [] }),
      ticketCard(evil, { siteUrl: SITE, handled: { action: 'closed', by: 'A', at: '', note: '[n](https://evil.test/n)' } }),
      filesCard({ clientId: 'c-9', clientName: evil.clientName, siteUrl: SITE, files: [{ id: 'u-1', name: '[f](https://evil.test/f)', at: '' }] }),
    ]
    for (const c of cards) {
      const body = JSON.stringify(c.body)
      expect(body).not.toContain('evil.test/a')
      expect(body).not.toContain('evil.test/s')
      expect(body).not.toContain('evil.test/t.png')
      expect(body).not.toContain('evil.test/n')
      expect(body).not.toContain('evil.test/f')
      // The only links in a card body are Shadow's own (the per-file View buttons).
      expect(body.replaceAll(SITE.replace(/\/$/, ''), '')).not.toContain('https://')
    }
    const texts = textsOf(cards[0])
    expect(texts).toContain('Title')
    expect(texts).toContain(`Click here or http${ZWSP}s://evil.test/raw`)
    expect(texts[0]).toBe('New ticket: Acme')
  })

  it('masks before making plain, then clips', () => {
    const c = ticketCard({ ...ticket, summary: `password: abc123 ${'x'.repeat(700)}` }, { siteUrl: SITE })
    const summary = textsOf(c).find((t) => t.includes('hidden'))!
    expect(summary.startsWith('password: \\[hidden\\] ')).toBe(true)
    expect(summary.length).toBe(MAX_SUMMARY)
  })
})

describe('helpCard', () => {
  it('lists the commands', () => {
    const s = json(helpCard({ siteUrl: SITE }))
    for (const cmd of ['link <accountant email>', 'link escalations', 'unlink', 'channels', 'help']) expect(s).toContain(cmd)
    expect(s).toContain('In this chat')
    for (const cmd of ['new chat', 'save this for']) expect(s).toContain(cmd)
    expect(s).not.toContain('—')
  })
})

describe('cardAttachment', () => {
  it('wraps the card as one adaptive card attachment', () => {
    const c = helpCard({ siteUrl: SITE })
    expect(cardAttachment(c)).toEqual({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: c }],
    })
  })
})

describe('parseCardAction', () => {
  const invoke = (data: unknown, extra: Record<string, unknown> = {}) => ({
    action: { type: 'Action.Execute', verb: 'ticket', data, ...extra },
  })

  it('accepts the data of a card button', () => {
    const data = executes(ticketCard(ticket, { siteUrl: SITE }))[0].data
    expect(parseCardAction(invoke(data, { id: 'x' }))).toEqual({ action: 'start', ticketId: 't-1', kind: 'ticket', ref: 't-1' })
  })

  it('picks up the vaId input merged into data', () => {
    expect(
      parseCardAction(invoke({ action: 'reassign', ticketId: 't-1', kind: 'escalation', ref: 'e-5', vaId: 'va-1' })),
    ).toEqual({ action: 'reassign', ticketId: 't-1', kind: 'escalation', ref: 'e-5', vaId: 'va-1' })
  })

  it('drops an empty vaId', () => {
    expect(parseCardAction(invoke({ action: 'reassign', ticketId: 't-1', kind: 'escalation', ref: 'e-5', vaId: '' }))).toEqual({
      action: 'reassign',
      ticketId: 't-1',
      kind: 'escalation',
      ref: 'e-5',
    })
  })

  it('rejects invalid shapes', () => {
    const good = { action: 'close', ticketId: 't-1', kind: 'ticket', ref: 't-1' }
    expect(parseCardAction(null)).toBeNull()
    expect(parseCardAction('start')).toBeNull()
    expect(parseCardAction({ action: { type: 'Action.Submit', verb: 'ticket', data: good } })).toBeNull()
    expect(parseCardAction({ action: { type: 'Action.Execute', verb: 'other', data: good } })).toBeNull()
    expect(parseCardAction(invoke({ ...good, action: 'delete' }))).toBeNull()
    expect(parseCardAction(invoke({ ...good, kind: 'nope' }))).toBeNull()
    expect(parseCardAction(invoke({ ...good, ticketId: '' }))).toBeNull()
    expect(parseCardAction(invoke({ ...good, ref: undefined }))).toBeNull()
    expect(parseCardAction(invoke({ ...good, vaId: 42 }))).toBeNull()
  })
})

// ---------------------------------------------------------------- follow-ups

const fu: FollowUpView = {
  id: 'f-1',
  clientId: 'c-9',
  clientName: 'Acme Traders',
  kind: 'promise',
  item: 'Send the GSTR-3B working',
  status: 'open',
  dueAt: '2026-11-18T12:30:00Z', // 6:00 pm IST
  createdAt: '2026-11-18T05:00:00Z',
  sourceAt: '2026-11-15T10:15:00Z', // 15 Nov, 3:45 pm IST
  sourceSender: 'Harshit Jain',
  vaId: 'va-2',
  vaName: 'Harshit Jain',
  conversationId: 'conv-1',
  reminderCount: 0,
  resolvedAt: null,
  resolvedBy: null,
}
const doc: FollowUpView = { ...fu, kind: 'document', item: 'Bank statement for October', dueAt: null }
const repeat: FollowUpView = { ...fu, kind: 'repeat_ask', item: 'When will the GST return be filed?', dueAt: null }
const FU_LINK = 'https://shadow.example.com/clients/c-9#follow-ups'
const FU_NOW = new Date('2026-11-18T10:15:00Z')

describe('followUpCard', () => {
  it('due: heading, item, due time, accountant and source time; Done, Not needed, Extend 1 day as reminder', () => {
    const ref = followUpRef('f-1', 'due')
    const c = followUpCard(fu, { siteUrl: SITE, what: 'due', ref })
    expect(c.version).toBe('1.5')
    const s = json(c)
    expect(textsOf(c)[0]).toBe('Promise due today: Acme Traders')
    expect(textsOf(c)).toContain('Send the GSTR-3B working')
    expect(s).toContain('18 Nov, 6:00 pm')
    expect(s).toContain('15 Nov, 3:45 pm')
    expect(s).toContain('Harshit Jain')
    expect(executes(c).map((a) => a.title)).toEqual(['Done', 'Not needed', 'Extend 1 day'])
    expect(executes(c).map((a) => a.verb)).toEqual(['followup', 'followup', 'followup'])
    expect(executes(c).map((a) => a.data)).toEqual([
      { action: 'done', followUpId: 'f-1', kind: 'reminder', ref },
      { action: 'cancel', followUpId: 'f-1', kind: 'reminder', ref },
      { action: 'extend', followUpId: 'f-1', kind: 'reminder', ref },
    ])
    expect((executes(c)[0] as Action & { style?: string }).style).toBe('positive')
    expect(openUrls(c)).toEqual([{ type: 'Action.OpenUrl', title: 'Open in Shadow', url: FU_LINK }])
  })

  it('missed: promise and document headings, escalation kind by default', () => {
    const p = followUpCard(fu, { siteUrl: SITE, what: 'missed', ref: followUpRef('f-1', 'missed') })
    expect(textsOf(p)[0]).toBe('Promise missed: Acme Traders')
    expect(executes(p).every((a) => a.data?.kind === 'escalation')).toBe(true)
    const d = followUpCard(doc, { siteUrl: SITE, what: 'missed', ref: followUpRef('f-1', 'missed') })
    expect(textsOf(d)[0]).toBe('Document still not received: Acme Traders')
    expect(executes(d).map((a) => a.title)).toEqual(['Done', 'Not needed', 'Extend 1 day'])
    expect(json(d)).not.toContain('"Due"')
  })

  it('chase: asked time ago and reminder number from the ref, else the stored count', () => {
    const c = followUpCard(doc, { siteUrl: SITE, what: 'chase', ref: followUpRef('f-1', 'chase', 2), now: FU_NOW })
    expect(textsOf(c)[0]).toBe('Chase document: Acme Traders')
    expect(textsOf(c)).toContain('Asked 3 days ago, reminder 2')
    expect(executes(c).every((a) => a.data?.kind === 'reminder')).toBe(true)
    const c0 = followUpCard({ ...doc, reminderCount: 1 }, { siteUrl: SITE, what: 'chase', ref: followUpRef('f-1', 'chase'), now: FU_NOW })
    expect(textsOf(c0)).toContain('Asked 3 days ago, reminder 1')
    const recent = followUpCard(
      { ...doc, sourceAt: '2026-11-18T08:00:00Z' },
      { siteUrl: SITE, what: 'chase', ref: followUpRef('f-1', 'chase', 1), now: FU_NOW },
    )
    expect(textsOf(recent)).toContain('Asked 2 h 15 min ago, reminder 1')
    // Cycle-aware ref (cycle * 10 + k) after an Extend: the label still shows the reminder number k.
    const cycled = followUpCard(doc, { siteUrl: SITE, what: 'chase', ref: followUpRef('f-1', 'chase', 20410 * 10 + 3), now: FU_NOW })
    expect(textsOf(cycled)).toContain('Asked 3 days ago, reminder 3')
  })

  it('repeat: heading, Answered and Not a repeat (no extend), escalation by default; kind can be overridden', () => {
    const ref = followUpRef('f-1', 'repeat')
    const c = followUpCard(repeat, { siteUrl: SITE, what: 'repeat', ref })
    expect(textsOf(c)[0]).toBe('Client asked again: Acme Traders')
    expect(executes(c).map((a) => a.title)).toEqual(['Answered', 'Not a repeat'])
    expect(executes(c).map((a) => a.data)).toEqual([
      { action: 'done', followUpId: 'f-1', kind: 'escalation', ref },
      { action: 'cancel', followUpId: 'f-1', kind: 'escalation', ref },
    ])
    const r = followUpCard(repeat, { siteUrl: SITE, what: 'repeat', ref, kind: 'reminder' })
    expect(executes(r).every((a) => a.data?.kind === 'reminder')).toBe(true)
  })

  it('handled: the Execute buttons become a line with who and when, the link stays', () => {
    const at = '2026-11-18T10:15:00Z'
    const ref = followUpRef('f-1', 'due')
    const done = followUpCard(fu, { siteUrl: SITE, what: 'due', ref, handled: { action: 'done', by: 'Asha', at } })
    expect(executes(done)).toHaveLength(0)
    expect(openUrls(done)).toHaveLength(1)
    expect(textsOf(done)).toContain('Marked done by Asha, 18 Nov, 3:45 pm')
    const cancelled = followUpCard(fu, { siteUrl: SITE, what: 'due', ref, handled: { action: 'cancelled', by: 'Asha', at } })
    expect(textsOf(cancelled)).toContain('Marked not needed by Asha, 18 Nov, 3:45 pm')
    const ext = followUpCard(fu, {
      siteUrl: SITE,
      what: 'due',
      ref,
      handled: { action: 'extended', by: 'Asha', at, note: 'New due date: 19 Nov, 6:00 pm' },
    })
    expect(textsOf(ext)).toContain('Extended by 1 day by Asha, 18 Nov, 3:45 pm')
    expect(textsOf(ext)).toContain('New due date: 19 Nov, 6:00 pm')
    const repeatRef = followUpRef('f-1', 'repeat')
    const ans = followUpCard(repeat, { siteUrl: SITE, what: 'repeat', ref: repeatRef, handled: { action: 'done', by: 'Asha', at } })
    expect(textsOf(ans)).toContain('Marked answered by Asha, 18 Nov, 3:45 pm')
    const nr = followUpCard(repeat, { siteUrl: SITE, what: 'repeat', ref: repeatRef, handled: { action: 'cancelled', by: 'Asha', at } })
    expect(textsOf(nr)).toContain('Marked not a repeat by Asha, 18 Nov, 3:45 pm')
  })

  it('client text is masked and plain: no links, no images, no credentials', () => {
    const evil: FollowUpView = {
      ...fu,
      clientName: 'Acme [click](https://evil.example)',
      item: 'Login password: Hunter2pass! see ![x](https://evil.example/a.png) www.evil.example',
      sourceSender: '**Boss** https://evil.example',
    }
    const c = followUpCard(evil, { siteUrl: SITE, what: 'due', ref: followUpRef('f-1', 'due') })
    const body = JSON.stringify(c.body)
    expect(body).not.toContain('](')
    expect(body).not.toContain('Hunter2pass')
    expect(body).not.toContain('https://evil')
    expect(body).not.toContain('www.evil')
    expect(body).not.toContain('**Boss**')
    expect(textsOf(c)[0]).toBe('Promise due today: Acme click')
  })
})

describe('parseFollowUpAction', () => {
  const ref = followUpRef('f-1', 'missed', 0)
  const invoke = (data: unknown, verb = 'followup') => ({ action: { type: 'Action.Execute', verb, data } })
  const good = { action: 'done', followUpId: 'f-1', kind: 'escalation', ref }

  it('accepts the data of a card button', () => {
    const data = executes(followUpCard(fu, { siteUrl: SITE, what: 'missed', ref }))[2].data
    expect(parseFollowUpAction(invoke(data))).toEqual({ action: 'extend', followUpId: 'f-1', kind: 'escalation', ref })
    expect(parseFollowUpAction(invoke(good))).toEqual(good)
  })

  it('rejects another verb, a ticket click and bad shapes', () => {
    expect(parseFollowUpAction(invoke(good, 'ticket'))).toBeNull()
    expect(parseFollowUpAction(null)).toBeNull()
    expect(parseFollowUpAction({ action: { type: 'Action.Submit', verb: 'followup', data: good } })).toBeNull()
    expect(parseFollowUpAction(invoke({ ...good, action: 'start' }))).toBeNull()
    expect(parseFollowUpAction(invoke({ ...good, kind: 'ticket' }))).toBeNull()
    expect(parseFollowUpAction(invoke({ ...good, followUpId: '' }))).toBeNull()
    expect(parseCardAction(invoke(good))).toBeNull()
  })

  it('rejects a ref of another follow-up or a malformed ref', () => {
    for (const bad of ['fu:f-2:missed:0', 'fu:f-1x:missed:0', 'f-1', 'fu:f-1:', 'fu:f-1:later:0', 'fu:f-1:due:x', 't-1@2026']) {
      expect(parseFollowUpAction(invoke({ ...good, ref: bad }))).toBeNull()
    }
  })

  it('followUpRefParts reads what and n', () => {
    expect(followUpRefParts('fu:f-1:chase:3', 'f-1')).toEqual({ what: 'chase', n: 3 })
    expect(followUpRefParts('fu:f-1:chase:3', 'f-2')).toBeNull()
  })
})
