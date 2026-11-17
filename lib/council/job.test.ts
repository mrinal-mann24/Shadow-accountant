import { describe, expect, it, vi } from 'vitest'
import type { Insert, Update } from '@/lib/db/types'
import { CANDIDATE_PAGE, MAX_CANDIDATE_PAGES, parseCouncilLimit, runCouncilJob } from './job'
import type { CouncilStore, DirectionFields, LogRow, PendingMessage, SlaCandidate, StoredConversation, StoredVerdict } from './store'
import type { Vote } from './types'
import type { VoteFn } from './vote'

const NOW = new Date('2026-11-16T12:00:00Z')
const TEAM = new Set(['9876543210'])

function msg(id: string, at: string, body: string, extra: Partial<PendingMessage> = {}): PendingMessage {
  return {
    message_id: id,
    client_id: 'c1',
    body,
    direction: 'incoming',
    sender_phone: '+91 99999 00000',
    sender_name: 'Ravi',
    message_timestamp: at,
    whatsapp_group_id: 'g1',
    ...extra,
  }
}

function conv(id: string, extra: Partial<StoredConversation> & { status?: string } = {}): StoredConversation & { status: string } {
  return {
    id,
    title: 'GST return',
    summary: 'Pending',
    last_message_at: '2026-11-14T10:00:00Z',
    message_count: 3,
    closed_at: null,
    status: 'open',
    ...extra,
  }
}

function vote(decision: Vote['decision'], target: string | null = null, extra: Partial<Vote> = {}): Vote {
  return {
    decision,
    target_conversation_id: target,
    title: 'TDS challan',
    summary: 'Client asked for TDS challan.',
    tag: 'neutral',
    fault: 'neither',
    client_tone: 'calm',
    va_tone: 'calm',
    reasoning: 'r',
    ...extra,
  }
}

type FailOnce = 'createConversation' | 'updateConversation' | 'markMessage'

/** In-memory CouncilStore that records every write and keeps state across runs. */
function fakeStore(init: {
  messages: PendingMessage[]
  conversations?: (StoredConversation & { status: string })[]
  verdicts?: Map<string, StoredVerdict>
  logs?: Map<string, LogRow>
  sla?: SlaCandidate[]
  between?: (clientId: string, after: string, until: string) => DirectionFields[]
  orphan?: string
  councilEnabled?: boolean
  failOnce?: FailOnce[]
}) {
  const writes = {
    verdicts: [] as Insert<'council_verdicts'>[],
    created: [] as Insert<'conversations'>[],
    updated: [] as [string, Update<'conversations'>][],
    marked: [] as [string, string | null][],
    logs: [] as Insert<'message_processing_log'>[],
    slaMarked: [] as string[],
    slaBefore: undefined as string | undefined,
    pageCalls: 0,
  }
  const convs = [...(init.conversations ?? [])]
  const verdicts = new Map(init.verdicts ?? [])
  const logs = new Map(init.logs ?? [])
  const processed = new Set<string>()
  const failOnce = new Set(init.failOnce ?? [])
  const maybeFail = (op: FailOnce) => {
    if (failOnce.delete(op)) throw new Error(`${op} timed out`)
  }
  let seq = 0
  const store: CouncilStore = {
    async councilClients() {
      return init.councilEnabled === false ? [] : [{ client_id: 'c1', client_name: 'Acme', va_id: 'va-1', whatsapp_group_id: 'g1' }]
    },
    async pendingMessages(_ids, limit, offset) {
      writes.pageCalls++
      return init.messages.filter((m) => !processed.has(m.message_id)).slice(offset, offset + limit)
    },
    async existingVerdicts(ids) {
      return new Map([...verdicts].filter(([id]) => ids.includes(id)))
    },
    async processingLog(ids) {
      return new Map([...logs].filter(([id]) => ids.includes(id)))
    },
    async recentMessages(m) {
      return init.messages.filter((x) => x.message_timestamp < m.message_timestamp)
    },
    async conversations() {
      return {
        open: convs.filter((c) => c.status === 'open'),
        recentlyClosed: convs.filter((c) => c.status === 'closed'),
      }
    },
    async slaMinutes() {
      return 120
    },
    async insertVerdict(row) {
      writes.verdicts.push(row)
      verdicts.set(row.message_id, { final_decision: row.final_decision, final_conv_id: row.final_conv_id ?? null })
      return `verdict-${writes.verdicts.length}`
    },
    async getConversation(id) {
      return convs.find((c) => c.id === id) ?? null
    },
    async findCouncilTicket() {
      return init.orphan ?? null
    },
    async createConversation(row) {
      const id = `new-${++seq}`
      convs.push(conv(id, { title: row.title ?? null, summary: row.summary ?? '', message_count: 1, last_message_at: row.last_message_at! }))
      writes.created.push(row)
      maybeFail('createConversation')
      return id
    },
    async updateConversation(id, patch) {
      maybeFail('updateConversation')
      writes.updated.push([id, patch])
      const c = convs.find((x) => x.id === id)
      if (c) {
        if (patch.status) c.status = patch.status
        if (patch.last_message_at) c.last_message_at = patch.last_message_at
        if (patch.message_count !== undefined) c.message_count = patch.message_count
      }
    },
    async markMessage(id, convId) {
      maybeFail('markMessage')
      writes.marked.push([id, convId])
      processed.add(id)
    },
    async upsertLog(row) {
      writes.logs.push(row)
      logs.set(row.message_id, { attempts: row.attempts ?? 0, max_attempts: row.max_attempts ?? 3, status: row.status ?? 'pending' })
    },
    async slaCandidates(_ids, before) {
      writes.slaBefore = before
      return init.sla ?? []
    },
    async messagesBetween(clientId, after, until) {
      return init.between?.(clientId, after, until) ?? []
    },
    async markSlaBreached(ids) {
      writes.slaMarked.push(...ids)
    },
  }
  return { store, writes, convs }
}

function voter(a: Vote | Error, b: Vote | Error): VoteFn & { calls: string[] } {
  const calls: string[] = []
  const fn: VoteFn = async (which) => {
    calls.push(which)
    const v = which === 'A' ? a : b
    if (v instanceof Error) throw v
    return { vote: v, model: which === 'A' ? 'anthropic/claude-sonnet-5' : 'openai/gpt-5.6-luna', latencyMs: 10 }
  }
  return Object.assign(fn, { calls })
}

const deps = (store: CouncilStore, vote: VoteFn, now: () => Date = () => NOW) => ({ store, vote, teamNumbers: TEAM, now })

const deadLog: LogRow = { attempts: 3, max_attempts: 3, status: 'failed' }
const sla = (id: string, last = '2026-11-16T08:00:00Z'): SlaCandidate => ({ id, client_id: 'c1', last_message_at: last })

describe('parseCouncilLimit', () => {
  it('defaults to 25 and clamps to 100', () => {
    expect(parseCouncilLimit(null)).toBe(25)
    expect(parseCouncilLimit('abc')).toBe(25)
    expect(parseCouncilLimit('0')).toBe(25)
    expect(parseCouncilLimit('10')).toBe(10)
    expect(parseCouncilLimit('500')).toBe(100)
  })
})

describe('runCouncilJob dry run', () => {
  it('without vote: lists candidates and makes no model calls (scheduled dry run costs nothing)', async () => {
    const { store, writes } = fakeStore({ messages: [msg('m1', '2026-11-16T09:00:00Z', 'Please send TDS challan')] })
    const v = voter(vote('new'), vote('new'))
    const res = await runCouncilJob({ write: false, limit: 25 }, deps(store, v))
    expect(v.calls).toHaveLength(0)
    expect(res).toMatchObject({ dryRun: true, processed: 0, written: 0, errors: [] })
    expect((res.details as { wouldVote: { message_id: string }[] }).wouldVote).toEqual([
      { message_id: 'm1', client_id: 'c1', at: '2026-11-16T09:00:00Z' },
    ])
    expect(writes.verdicts).toHaveLength(0)
  })

  it('with vote: returns decisions and writes nothing', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'Please send TDS challan')],
      sla: [sla('old-conv')],
    })
    const res = await runCouncilJob({ write: false, limit: 25, vote: true }, deps(store, voter(vote('new'), vote('new'))))
    expect(res).toMatchObject({ job: 'council', dryRun: true, processed: 1, written: 0, errors: [] })
    const details = res.details as { outcomes: { final: { decision: string } }[]; sla: { breached: string[]; slaMinutes: number } }
    expect(details.outcomes[0].final.decision).toBe('new')
    expect(details.sla).toMatchObject({ slaMinutes: 120, breached: ['old-conv'] })
    expect(writes.verdicts).toHaveLength(0)
    expect(writes.created).toHaveLength(0)
    expect(writes.marked).toHaveLength(0)
    expect(writes.logs).toHaveLength(0)
    expect(writes.slaMarked).toHaveLength(0)
    expect(writes.slaBefore).toBe('2026-11-16T10:00:00.000Z')
  })

  it('does nothing when no client has the council enabled', async () => {
    const { store } = fakeStore({ messages: [msg('m1', '2026-11-16T09:00:00Z', 'hi')], councilEnabled: false })
    const v = voter(vote('new'), vote('new'))
    const res = await runCouncilJob({ write: false, limit: 25, vote: true }, deps(store, v))
    expect(res.processed).toBe(0)
    expect(v.calls).toHaveLength(0)
  })
})

describe('runCouncilJob write mode', () => {
  it('new: opens the ticket, then inserts the verdict linked to it, then marks the message', async () => {
    const { store, writes } = fakeStore({ messages: [msg('m1', '2026-11-16T09:00:00Z', 'Please send TDS challan')] })
    const res = await runCouncilJob(
      { write: true, limit: 25 },
      deps(store, voter(vote('new', null, { tag: 'complaint', fault: 'us' }), vote('new'))),
    )
    expect(res).toMatchObject({ dryRun: false, processed: 1, written: 1, errors: [] })
    expect(writes.verdicts[0]).toMatchObject({
      message_id: 'm1',
      claude_model: 'anthropic/claude-sonnet-5',
      gpt_model: 'openai/gpt-5.6-luna',
      claude_decision: 'new',
      gpt_decision: 'new',
      final_decision: 'new',
      agreed: true,
      final_conv_id: 'new-1',
    })
    expect(writes.created[0]).toMatchObject({
      client_id: 'c1',
      opened_by: 'incoming',
      va_id: 'va-1',
      tag: 'complaint',
      fault: 'us',
      status: 'open',
      title: 'TDS challan',
      message_count: 1,
      last_message_direction: 'incoming',
    })
    expect(writes.marked).toEqual([['m1', 'new-1']])
    expect(writes.logs[0]).toMatchObject({ message_id: 'm1', attempts: 1, status: 'done', error: null })
  })

  it('continue: bumps count, last message and summary, using the effective direction', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'Filed, sharing ack', { sender_phone: '+919876543210' })],
      conversations: [conv('conv-1')],
    })
    await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('continue', 'conv-1'), vote('new'))))
    expect(writes.verdicts[0]).toMatchObject({ final_decision: 'continue', final_conv_id: 'conv-1', agreed: false })
    expect(writes.updated[0]).toEqual([
      'conv-1',
      expect.objectContaining({
        last_message_at: '2026-11-16T09:00:00Z',
        last_message_direction: 'outgoing',
        message_count: 4,
        summary: 'Client asked for TDS challan.',
      }),
    ])
    expect(writes.marked).toEqual([['m1', 'conv-1']])
  })

  it('close: sets status closed and closed_at only when both agree', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'Got it, all sorted')],
      conversations: [conv('conv-1')],
    })
    await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('close', 'conv-1'), vote('close', 'conv-1'))))
    expect(writes.updated[0][1]).toMatchObject({ status: 'closed', closed_at: '2026-11-16T09:00:00Z' })
  })

  it('reopen: sets status open and clears closed_at', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'This is still not filed')],
      conversations: [conv('conv-9', { status: 'closed', closed_at: '2026-11-12T10:00:00Z' })],
    })
    await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('reopen', 'conv-9'), vote('reopen', 'conv-9'))))
    expect(writes.updated[0][1]).toMatchObject({ status: 'open', closed_at: null })
  })

  it('treats an invented target id as no_action and still marks the message processed', async () => {
    const { store, writes } = fakeStore({ messages: [msg('m1', '2026-11-16T09:00:00Z', 'ok')], conversations: [conv('conv-1')] })
    await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('close', 'fake'), vote('close', 'fake'))))
    expect(writes.verdicts[0]).toMatchObject({ claude_decision: 'no_action', final_decision: 'no_action', agreed: true })
    expect(writes.updated).toHaveLength(0)
    expect(writes.marked).toEqual([['m1', null]])
  })

  it('a second message in the same batch can continue the ticket the first one opened', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'Need GST help'), msg('m2', '2026-11-16T09:05:00Z', 'Also attaching the bills')],
    })
    let n = 0
    const v: VoteFn = async (which) => {
      n++
      const d = n <= 2 ? vote('new') : vote('continue', 'new-1')
      return { vote: d, model: which, latencyMs: 1 }
    }
    const res = await runCouncilJob({ write: true, limit: 25 }, deps(store, v))
    expect(res.written).toBe(2)
    expect(writes.created).toHaveLength(1)
    expect(writes.marked).toEqual([
      ['m1', 'new-1'],
      ['m2', 'new-1'],
    ])
  })

  it('retries a failing model once, then logs the failure without marking the message', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'hello')],
      logs: new Map([['m1', { attempts: 1, max_attempts: 3, status: 'failed' }]]),
    })
    const v = voter(vote('new'), new Error('timeout'))
    const res = await runCouncilJob({ write: true, limit: 25 }, deps(store, v))
    expect(v.calls.filter((c) => c === 'B')).toHaveLength(2)
    expect(res.written).toBe(0)
    expect(res.errors[0]).toMatch(/m1: timeout/)
    expect(writes.verdicts).toHaveLength(0)
    expect(writes.marked).toHaveLength(0)
    expect(writes.logs[0]).toMatchObject({ message_id: 'm1', attempts: 2, status: 'failed', error: 'timeout' })
  })

  it('skips messages that already have a no_action verdict and marks them processed', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'hello')],
      verdicts: new Map([['m1', { final_decision: 'no_action', final_conv_id: null }]]),
    })
    const v = voter(vote('new'), vote('new'))
    const res = await runCouncilJob({ write: true, limit: 25 }, deps(store, v))
    expect(v.calls).toHaveLength(0)
    expect(res.processed).toBe(0)
    expect(writes.verdicts).toHaveLength(0)
    expect(writes.marked).toEqual([['m1', null]])
  })

  it('skips messages that have used up their attempts', async () => {
    const { store } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'hello'), msg('m2', '2026-11-16T09:01:00Z', 'next')],
      logs: new Map([['m1', deadLog]]),
    })
    const res = await runCouncilJob({ write: false, limit: 1, vote: true }, deps(store, voter(vote('new'), vote('new'))))
    expect(res.processed).toBe(1)
    expect((res.details as { outcomes: { message_id: string }[] }).outcomes[0].message_id).toBe('m2')
  })

  it('marks SLA breaches in write mode', async () => {
    const { store, writes } = fakeStore({ messages: [], sla: [sla('conv-a'), sla('conv-b')] })
    await runCouncilJob({ write: true, limit: 25 }, deps(store, vi.fn()))
    expect(writes.slaMarked).toEqual(['conv-a', 'conv-b'])
  })
})

describe('runCouncilJob queue with dead messages', () => {
  it('pages past more than limit x 3 dead messages at the head and still votes on newer ones', async () => {
    const deadCount = 400
    const messages = [
      ...Array.from({ length: deadCount }, (_, i) => msg(`d${i}`, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), 'x')),
      msg('live-1', '2026-11-16T09:00:00Z', 'new question'),
      msg('live-2', '2026-11-16T09:01:00Z', 'another'),
    ]
    const logs = new Map(messages.slice(0, deadCount).map((m) => [m.message_id, deadLog]))
    const { store, writes } = fakeStore({ messages, logs })
    const res = await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('no_action'), vote('no_action'))))
    expect(res.processed).toBe(2)
    expect(res.written).toBe(2)
    expect(res.errors).toEqual([])
    expect(writes.marked.map(([id]) => id)).toEqual(['live-1', 'live-2'])
    expect(writes.pageCalls).toBe(2)
  })

  it('reports an error when the page cap is reached with only dead messages', async () => {
    const total = CANDIDATE_PAGE * MAX_CANDIDATE_PAGES + 5
    const messages = Array.from({ length: total }, (_, i) => msg(`d${i}`, new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), 'x'))
    const { store } = fakeStore({ messages, logs: new Map(messages.map((m) => [m.message_id, deadLog])) })
    const v = voter(vote('new'), vote('new'))
    const res = await runCouncilJob({ write: true, limit: 25 }, deps(store, v))
    expect(v.calls).toHaveLength(0)
    expect(res.processed).toBe(0)
    expect(res.errors[0]).toMatch(/used up their retries/)
  })
})

describe('runCouncilJob partial failures', () => {
  it('updateConversation fails once: the next run re-applies the stored close before marking the message', async () => {
    const { store, writes, convs } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'All sorted, thanks'), msg('m2', '2026-11-16T09:10:00Z', 'One more thing')],
      conversations: [conv('conv-1')],
      failOnce: ['updateConversation'],
    })
    const v = voter(vote('close', 'conv-1'), vote('close', 'conv-1'))
    const first = await runCouncilJob({ write: true, limit: 25 }, deps(store, v))
    expect(first.errors[0]).toMatch(/m1: updateConversation timed out/)
    expect(writes.verdicts).toHaveLength(1)
    expect(writes.marked).toHaveLength(0)
    // m2 waits so the next run sees m1 first and decisions stay in order
    expect((first.details as { skipped: { message_id: string; reason: string }[] }).skipped).toContainEqual({
      message_id: 'm2',
      reason: 'an earlier message of this client failed in this run',
    })

    const second = await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('no_action'), vote('no_action'))))
    expect(second.errors).toEqual([])
    expect(writes.updated[0]).toEqual(['conv-1', expect.objectContaining({ status: 'closed', closed_at: '2026-11-16T09:00:00Z', message_count: 4 })])
    expect(convs.find((c) => c.id === 'conv-1')?.status).toBe('closed')
    expect(writes.marked).toEqual([
      ['m1', 'conv-1'],
      ['m2', null],
    ])
    expect(writes.verdicts).toHaveLength(2) // m1 once, m2 once
  })

  it('does not apply a stored decision twice when only marking the message failed', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'Sharing the bills')],
      conversations: [conv('conv-1')],
      failOnce: ['markMessage'],
    })
    await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('continue', 'conv-1'), vote('continue', 'conv-1'))))
    expect(writes.updated).toHaveLength(1)
    await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('new'), vote('new'))))
    expect(writes.updated).toHaveLength(1)
    expect(writes.marked).toEqual([['m1', 'conv-1']])
  })

  it('createConversation fails after the insert: no verdict, and the re-vote reuses that ticket', async () => {
    const { store, writes } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'Need a GST registration')],
      failOnce: ['createConversation'],
    })
    const first = await runCouncilJob({ write: true, limit: 25 }, deps(store, voter(vote('new'), vote('new'))))
    expect(first.errors[0]).toMatch(/createConversation timed out/)
    expect(writes.verdicts).toHaveLength(0)
    expect(writes.marked).toHaveLength(0)

    // The orphan ticket is found by client + opened_at and reused, so there is still one ticket.
    const { store: store2, writes: writes2 } = fakeStore({
      messages: [msg('m1', '2026-11-16T09:00:00Z', 'Need a GST registration')],
      orphan: 'new-1',
    })
    await runCouncilJob({ write: true, limit: 25 }, deps(store2, voter(vote('new'), vote('new'))))
    expect(writes2.created).toHaveLength(0)
    expect(writes2.verdicts[0]).toMatchObject({ final_decision: 'new', final_conv_id: 'new-1' })
    expect(writes2.marked).toEqual([['m1', 'new-1']])
  })
})

describe('runCouncilJob time budget', () => {
  it('stops taking new messages after the budget and still runs SLA marking', async () => {
    let t = NOW.getTime()
    const now = () => new Date(t)
    const v: VoteFn = async (which) => {
      t += 60_000 // each model call takes a minute of fake time
      return { vote: vote('no_action'), model: which, latencyMs: 60_000 }
    }
    const { store, writes } = fakeStore({
      messages: [1, 2, 3, 4, 5].map((i) => msg(`m${i}`, `2026-11-16T09:0${i}:00Z`, 'x')),
      sla: [sla('conv-a')],
    })
    const res = await runCouncilJob({ write: true, limit: 25, budgetMs: 150_000 }, deps(store, v, now))
    expect(res.processed).toBe(2)
    expect((res.details as { stoppedEarly: { remaining: number } }).stoppedEarly).toEqual({ remaining: 3 })
    expect(writes.slaMarked).toEqual(['conv-a'])
  })
})

describe('runCouncilJob SLA', () => {
  it('does not flag a ticket the team replied to in time, even when the reply is not on the ticket', async () => {
    const { store, writes } = fakeStore({
      messages: [],
      sla: [sla('answered', '2026-11-16T08:00:00Z'), sla('late', '2026-11-16T07:00:00Z'), sla('silent', '2026-11-16T06:00:00Z')],
      between: (_c, after) =>
        after === '2026-11-16T08:00:00Z'
          ? [{ direction: 'incoming', sender_phone: '+91 98765 43210' }] // stored incoming, but a team number
          : after === '2026-11-16T07:00:00Z'
            ? [{ direction: 'incoming', sender_phone: '+91 99999 00000' }] // the client again, no reply
            : [],
    })
    const res = await runCouncilJob({ write: true, limit: 25 }, deps(store, vi.fn()))
    expect(writes.slaMarked).toEqual(['late', 'silent'])
    expect((res.details as { sla: { answeredInTime: string[] } }).sla.answeredInTime).toEqual(['answered'])
  })

  it('looks for a reply only within sla_minutes after the last client message', async () => {
    const calls: [string, string][] = []
    const { store } = fakeStore({
      messages: [],
      sla: [sla('t', '2026-11-16T08:00:00Z')],
      between: (_c, after, until) => {
        calls.push([after, until])
        return []
      },
    })
    await runCouncilJob({ write: false, limit: 25 }, deps(store, vi.fn()))
    expect(calls).toEqual([['2026-11-16T08:00:00Z', '2026-11-16T10:00:00.000Z']])
  })
})
