import { describe, expect, it } from 'vitest'
import {
  cardAttachment,
  escalationCard,
  filesCard,
  formatIst,
  formatWaiting,
  helpCard,
  MAX_SUMMARY,
  MAX_TITLE,
  parseCardAction,
  plainText,
  reminderCard,
  ticketCard,
} from './cards'
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
    const files = Array.from({ length: 13 }, (_, i) => ({ name: `invoice-${i + 1}.pdf`, at: '2026-11-18T10:15:00Z' }))
    const c = filesCard({ clientId: 'c-9', clientName: 'Acme Traders', files, siteUrl: SITE })
    const s = json(c)
    expect(s).toContain('13 new files from Acme Traders')
    expect(s).toContain('invoice-10.pdf')
    expect(s).not.toContain('invoice-11.pdf')
    expect(s).toContain('+ 3 more')
    expect(executes(c)).toHaveLength(0)
    expect(openUrls(c)).toEqual([
      { type: 'Action.OpenUrl', title: 'Open client', url: 'https://shadow.example.com/clients/c-9' },
    ])
  })

  it('uses the singular for one file', () => {
    const c = filesCard({ clientId: 'c-9', clientName: 'Acme', files: [{ name: 'a.pdf', at: '' }], siteUrl: SITE })
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
      filesCard({ clientId: 'c-9', clientName: evil.clientName, siteUrl: SITE, files: [{ name: '[f](https://evil.test/f)', at: '' }] }),
    ]
    for (const c of cards) {
      const body = JSON.stringify(c.body)
      expect(body).not.toContain('evil.test/a')
      expect(body).not.toContain('evil.test/s')
      expect(body).not.toContain('evil.test/t.png')
      expect(body).not.toContain('evil.test/n')
      expect(body).not.toContain('evil.test/f')
      expect(body).not.toContain('https://')
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
    expect(s).toContain('Ask any question about your clients')
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
