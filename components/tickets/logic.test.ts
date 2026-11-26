import { describe, expect, it } from 'vitest'
import type { ConversationItem, MessageItem } from '@/lib/data/types'
import {
  buildTimeline,
  countOpenTicketTags,
  firstReply,
  groupTicketsByClient,
  parseFileShared,
  shortAge,
  ticketHref,
  ticketTitle,
  ticketUrgency,
} from './logic'

const NOW = new Date('2026-11-26T08:00:00Z')

function ticket(id: string, o: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id,
    clientId: 'c1',
    clientName: 'Alpha',
    vaId: 'va1',
    title: `Ticket ${id}`,
    summary: '',
    status: 'open',
    tag: 'neutral',
    fault: null,
    clientTone: null,
    vaTone: null,
    slaBreached: false,
    openedAt: '2026-11-26T06:00:00Z',
    openedBy: 'council',
    closedAt: null,
    lastMessageAt: '2026-11-26T07:50:00Z',
    lastMessageDirection: 'outgoing',
    messageCount: 2,
    ...o,
  }
}

function msg(id: string, at: string, direction: 'incoming' | 'outgoing', body = 'hi'): MessageItem {
  return {
    id,
    waMessageId: id,
    at,
    body,
    senderName: null,
    direction,
    storedDirection: direction,
    fromTeam: direction === 'outgoing',
    messageType: 'chat',
    conversationId: 't1',
  }
}

describe('countOpenTicketTags', () => {
  it('counts open tickets per tag in TAGS order and keeps untagged apart', () => {
    const r = countOpenTicketTags([
      ticket('1', { tag: 'complaint' }),
      ticket('2', { tag: 'complaint' }),
      ticket('3', { tag: 'suspense' }),
      ticket('4', { tag: null }),
      ticket('5', { tag: 'weird' }),
      ticket('6', { tag: 'complaint', status: 'closed' }),
    ])
    expect(r.counts.map((c) => [c.tag, c.count])).toEqual([
      ['escalation', 0],
      ['complaint', 2],
      ['neutral', 0],
      ['positive', 0],
      ['suspense', 1],
    ])
    expect(r.counts[2].label).toBe('Request or question')
    expect(r.untagged).toBe(2)
  })
})

describe('groupTicketsByClient', () => {
  it('puts clients with most tickets first, ties by first appearance, keeps ticket order', () => {
    const groups = groupTicketsByClient([
      ticket('a1', { clientId: 'a', clientName: 'A' }),
      ticket('b1', { clientId: 'b', clientName: 'B', vaId: 'va2' }),
      ticket('c1', { clientId: 'c', clientName: 'C' }),
      ticket('b2', { clientId: 'b', clientName: 'B', vaId: 'va3' }),
      ticket('b3', { clientId: 'b', clientName: 'B', vaId: 'va2' }),
    ])
    expect(groups.map((g) => g.clientId)).toEqual(['b', 'a', 'c'])
    expect(groups[0].tickets.map((t) => t.id)).toEqual(['b1', 'b2', 'b3'])
    expect(groups[0].vaIds).toEqual(['va2', 'va3'])
  })
  it('returns [] for no tickets', () => {
    expect(groupTicketsByClient([])).toEqual([])
  })
})

describe('ticketUrgency', () => {
  it('breached beats waiting; long wait at 60 min; closed and replied', () => {
    expect(ticketUrgency(ticket('1', { slaBreached: true }), NOW)).toBe('breached')
    expect(ticketUrgency(ticket('1', { lastMessageDirection: 'incoming', lastMessageAt: '2026-11-26T07:00:00Z' }), NOW)).toBe(
      'waiting-long',
    )
    expect(ticketUrgency(ticket('1', { lastMessageDirection: 'incoming', lastMessageAt: '2026-11-26T07:30:00Z' }), NOW)).toBe(
      'waiting',
    )
    expect(ticketUrgency(ticket('1'), NOW)).toBe('replied')
    expect(ticketUrgency(ticket('1', { status: 'closed', slaBreached: true }), NOW)).toBe('closed')
  })
})

describe('small formatters', () => {
  it('shortAge', () => {
    expect(shortAge('2026-11-26T08:00:00Z', NOW)).toBe('now')
    expect(shortAge('2026-11-26T07:48:00Z', NOW)).toBe('12 m')
    expect(shortAge('2026-11-26T06:55:00Z', NOW)).toBe('1 h 5 m')
    expect(shortAge('2026-11-26T06:00:00Z', NOW)).toBe('2 h')
    expect(shortAge('2026-11-23T08:00:00Z', NOW)).toBe('3 d')
    expect(shortAge('bad', NOW)).toBe('')
  })
  it('ticketTitle falls back to the summary', () => {
    expect(ticketTitle({ title: null, summary: 'Needs GST filing' })).toBe('Needs GST filing')
    expect(ticketTitle({ title: null, summary: '' })).toBe('Untitled ticket')
  })
  it('ticketHref keeps filters and drops the default status', () => {
    expect(ticketHref({ status: 'open', tag: undefined, q: '' }, 't1')).toBe('/tickets?t=t1')
    expect(ticketHref({ status: 'closed', tag: 'complaint', q: 'gst bill' }, 't1')).toBe(
      '/tickets?status=closed&tag=complaint&q=gst+bill&t=t1',
    )
  })
})

describe('parseFileShared', () => {
  it('reads file name and caption', () => {
    expect(parseFileShared('[File shared: ICICI letter.pdf]')).toEqual({ fileName: 'ICICI letter.pdf', caption: '' })
    expect(parseFileShared('[File shared: a.xlsx] October sales')).toEqual({ fileName: 'a.xlsx', caption: 'October sales' })
    expect(parseFileShared('Please see [File shared: x]')).toBeNull()
    expect(parseFileShared(null)).toBeNull()
  })
})

describe('firstReply', () => {
  it('minutes from first client message to the next team message', () => {
    expect(
      firstReply([
        msg('0', '2026-11-26T06:40:00Z', 'outgoing'),
        msg('1', '2026-11-26T06:43:00Z', 'incoming'),
        msg('2', '2026-11-26T06:45:00Z', 'outgoing'),
      ]),
    ).toEqual({ kind: 'replied', minutes: 2 })
  })
  it('waiting when the team has not replied, none when the client never wrote', () => {
    expect(firstReply([msg('1', '2026-11-26T06:43:00Z', 'incoming')])).toEqual({ kind: 'waiting', since: '2026-11-26T06:43:00Z' })
    expect(firstReply([msg('1', '2026-11-26T06:43:00Z', 'outgoing')])).toEqual({ kind: 'none' })
    expect(firstReply([])).toEqual({ kind: 'none' })
  })
})

describe('buildTimeline', () => {
  it('IST time, day heading on day change, side and file details', () => {
    const ev = buildTimeline([
      msg('1', '2026-11-25T06:43:00Z', 'incoming', 'Need the ICICI letter'),
      msg('2', '2026-11-25T07:30:00Z', 'outgoing', '[File shared: ICICI letter.pdf] Signed copy'),
      msg('3', '2026-11-26T04:00:00Z', 'incoming', 'Thanks'),
    ])
    expect(ev.map((e) => [e.time, e.day, e.who])).toEqual([
      ['12:13 pm', '25 Nov', 'client'],
      ['1:00 pm', null, 'team'],
      ['9:30 am', '26 Nov', 'client'],
    ])
    expect(ev[1].file).toEqual({ fileName: 'ICICI letter.pdf', caption: 'Signed copy' })
    expect(ev[1].text).toBe('Signed copy')
    expect(ev[0].text).toBe('Need the ICICI letter')
  })
})
