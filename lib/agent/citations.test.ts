import { describe, expect, it } from 'vitest'
import {
  citationsFromToolOutput,
  citedNumbers,
  clientLabel,
  createCitationRegistry,
  fileLabel,
  formatCitationDate,
  formatCitationTime,
  meetingLabel,
  messageLabel,
  nextCitationStart,
  shorten,
  sourceLink,
  splitCitations,
  ticketLabel,
  unknownCitations,
} from './citations'

describe('formatCitationTime / formatCitationDate', () => {
  it('formats in India time', () => {
    // 09:35 UTC = 15:05 IST
    expect(formatCitationTime('2026-11-16T09:35:00Z')).toBe('16 Nov 2026, 3:05 pm')
    expect(formatCitationDate('2026-11-16T20:00:00Z')).toBe('17 Nov 2026') // already the next day in IST
  })
  it('uses the given timezone', () => {
    expect(formatCitationTime('2026-01-01T00:00:00Z', 'UTC')).toBe('1 Jan 2026, 12:00 am')
  })
  it('returns empty for missing or bad dates', () => {
    expect(formatCitationTime(null)).toBe('')
    expect(formatCitationDate('not a date')).toBe('')
  })
})

describe('labels', () => {
  it('message label has source, time and sender, no em dash', () => {
    const l = messageLabel({ at: '2026-11-16T09:35:00Z', senderName: 'Ravi Kumar', fromTeam: false })
    expect(l).toBe('WhatsApp, 16 Nov 2026, 3:05 pm, Ravi Kumar')
    expect(l).not.toContain('—')
  })
  it('message label falls back to team or client', () => {
    expect(messageLabel({ at: '2026-11-16T09:35:00Z', senderName: ' ', fromTeam: true })).toMatch(/, team$/)
    expect(messageLabel({ at: '2026-11-16T09:35:00Z', senderName: null, fromTeam: false })).toMatch(/, client$/)
  })
  it('file label uses file name and upload date', () => {
    expect(fileLabel({ fileName: 'HDFC Oct.pdf', folderName: 'Client Files/X', uploadedAt: '2026-11-02T05:00:00Z' })).toBe(
      'File HDFC Oct.pdf, 2 Nov 2026',
    )
    expect(fileLabel({ fileName: null, folderName: 'Client Files/X', uploadedAt: null })).toBe('File Client Files/X')
  })
  it('meeting label uses subject and start time, else date', () => {
    expect(meetingLabel({ subject: 'Monthly review', start: '2026-11-10T06:30:00Z', date: null })).toBe(
      'Meeting Monthly review, 10 Nov 2026, 12:00 pm',
    )
    expect(meetingLabel({ subject: null, start: null, date: '2026-11-10' })).toBe('Meeting Untitled meeting, 10 Nov 2026')
  })
  it('ticket label uses title, else summary', () => {
    expect(ticketLabel({ title: 'GST notice', summary: 's', openedAt: '2026-11-01T10:00:00Z' })).toBe(
      'Ticket GST notice, opened 1 Nov 2026',
    )
    expect(ticketLabel({ title: null, summary: 'Client asked about TDS', openedAt: '2026-11-01T10:00:00Z' })).toContain(
      'Client asked about TDS',
    )
  })
  it('client label', () => {
    expect(clientLabel('Leapmile Logistics')).toBe('Client profile, Leapmile Logistics')
  })
})

describe('shorten', () => {
  it('collapses whitespace and cuts with dots', () => {
    expect(shorten('a\n\n b   c', 100)).toBe('a b c')
    expect(shorten('abcdefghij', 8)).toBe('abcde...')
    expect(shorten(null, 5)).toBe('')
  })
})

describe('sourceLink', () => {
  it('links to the client page with an anchor per source', () => {
    expect(sourceLink('message', 'c1', 'm1')).toBe('/clients/c1#message-m1')
    expect(sourceLink('client', 'c1', 'c1')).toBe('/clients/c1')
    expect(sourceLink('file', 'c 1', 'f/1')).toBe('/clients/c%201#file-f%2F1')
  })
})

describe('createCitationRegistry', () => {
  it('numbers sources in order from the start and reuses the number for the same source', () => {
    const r = createCitationRegistry(4)
    const a = r.add({ kind: 'message', id: 'm1', clientId: 'c1', at: null, label: 'A' })
    const b = r.add({ kind: 'file', id: 'm1', clientId: 'c1', at: null, label: 'B' })
    const again = r.add({ kind: 'message', id: 'm1', clientId: 'c1', at: null, label: 'A2' })
    expect([a.n, b.n, again.n]).toEqual([4, 5, 4])
    expect(r.all().map((c) => c.n)).toEqual([4, 5])
  })
  it('never starts below 1', () => {
    expect(createCitationRegistry(0).add({ kind: 'client', id: 'c', clientId: 'c', at: null, label: 'x' }).n).toBe(1)
  })
})

describe('citation markers', () => {
  it('finds single, grouped and adjacent markers', () => {
    expect(citedNumbers('Filed [1]. Paid [2, 3][4]. Not a cite: [a] or [ ].')).toEqual([1, 2, 3, 4])
  })
  it('nextCitationStart continues after the highest number used', () => {
    expect(nextCitationStart([])).toBe(1)
    expect(nextCitationStart(['See [2] and [7].', 'Also [3].'])).toBe(8)
  })
  it('splitCitations keeps text and cites in order', () => {
    expect(splitCitations('GST filed [1][2]. Done')).toEqual([
      { type: 'text', text: 'GST filed ' },
      { type: 'cite', n: 1 },
      { type: 'cite', n: 2 },
      { type: 'text', text: '. Done' },
    ])
    expect(splitCitations('no cites')).toEqual([{ type: 'text', text: 'no cites' }])
  })
  it('unknownCitations flags numbers no tool returned', () => {
    expect(unknownCitations('a [1] b [9] c [9]', [1, 2])).toEqual([9])
  })
})

describe('citationsFromToolOutput', () => {
  it('reads citations from items and ignores junk', () => {
    const c = { n: 1, kind: 'message', id: 'm1', clientId: 'c1', at: null, label: 'L' }
    expect(citationsFromToolOutput({ items: [{ citation: c }, { citation: { n: 'x' } }, null, 5] })).toEqual([c])
    expect(citationsFromToolOutput({ items: 'nope' })).toEqual([])
    expect(citationsFromToolOutput(null)).toEqual([])
  })
})
