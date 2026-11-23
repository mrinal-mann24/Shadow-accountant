import type { LanguageModel, ToolSet } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import { createFakeSupabase } from '@/lib/data/testing/fake-supabase'
import type { CitationRegistry } from './citations'
import type { ChatScope } from './scope'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import { ASK_SAFETY_RULE, askShadowWith, defaultAskDeps, EMPTY_QUESTION, normalizeCitations, sanitizeAnswer, TEAMS_CHAT_RULE, type AskDeps } from './ask'

const ZWSP = String.fromCharCode(0x200b)

const asha: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const admin: AppUser = { id: 'u2', email: 'admin@example.com', name: 'Admin', role: 'admin', vaId: null }

const fakeModel = { modelId: 'fake' } as unknown as LanguageModel

beforeEach(() => {
  state.db = createFakeSupabase({
    vas: [
      { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com', status: 'active' },
      { va_id: 'va2', va_name: 'Ravi', email: 'ravi@example.com', status: 'active' },
    ],
    clients: [
      { client_id: 'c1', client_name: 'Alpha Traders', va_id: 'va1', status: 'active' },
      { client_id: 'c2', client_name: 'Beta Foods', va_id: 'va2', status: 'active' },
      { client_id: 'c3', client_name: 'Gamma Labs', va_id: 'va1', status: 'inactive' },
    ],
  }).client
})

type Seen = { scope?: ChatScope; instructions?: string; messages?: unknown; user?: AppUser }

/** Real (user scoped) client loader; fake model, tools that register citations 1-3, and a canned answer. */
function testDeps(answer: string, seen: Seen = {}): AskDeps {
  return {
    ...defaultAskDeps,
    model: () => fakeModel,
    tools: (ctx: { user: AppUser; scope: ChatScope; registry: CitationRegistry; timeZone: string }): ToolSet => {
      seen.scope = ctx.scope
      seen.user = ctx.user
      ctx.registry.add({ kind: 'message', id: 'm1', clientId: 'c1', at: null, label: 'WhatsApp, 1 Nov', link: '/clients/c1#message-m1' })
      ctx.registry.add({ kind: 'file', id: 'f1', clientId: 'c1', at: null, label: 'File GST.pdf' })
      ctx.registry.add({ kind: 'ticket', id: 't1', clientId: 'c1', at: null, label: 'Ticket GST', link: '/clients/c1#ticket-t1' })
      return {}
    },
    generate: async (o) => {
      seen.instructions = o.instructions
      seen.messages = o.messages
      expect(o.model).toBe(fakeModel)
      expect(o.temperature).toBe(0.1)
      expect(o.maxOutputTokens).toBe(1500)
      return { text: answer }
    },
    now: () => new Date('2026-11-18T06:00:00Z'),
  }
}

describe('askShadowWith', () => {
  it('scopes a senior accountant to their own clients', async () => {
    const seen: Seen = {}
    await askShadowWith(testDeps('ok', seen), asha, 'Any open GST issues?')
    expect(seen.user).toBe(asha)
    expect(seen.scope?.clients.map((c) => c.id).sort()).toEqual(['c1', 'c3'])
    expect(seen.scope?.allClients).toBe(false)
    expect(seen.instructions).toContain('Alpha Traders')
    expect(seen.instructions).not.toContain('Beta Foods')
    expect(seen.messages).toEqual([{ role: 'user', content: 'Any open GST issues?' }])
  })

  it('an admin sees every client', async () => {
    const seen: Seen = {}
    await askShadowWith(testDeps('ok', seen), admin, 'hi')
    expect(seen.scope?.clients.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(seen.scope?.allClients).toBe(true)
  })

  it('locks to a picked client in scope and refuses one outside it', async () => {
    const seen: Seen = {}
    await askShadowWith(testDeps('ok', seen), asha, 'hi', { clientId: 'c1' })
    expect(seen.scope?.fixedClientId).toBe('c1')
    await expect(askShadowWith(testDeps('ok'), asha, 'hi', { clientId: 'c2' })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('returns only the citations used in the answer, with links when present', async () => {
    const r = await askShadowWith(testDeps('  Filed on 12 Nov [1]. Ticket raised [3][9].  '), asha, 'status?')
    expect(r.text).toBe('Filed on 12 Nov [1]. Ticket raised [3][9].')
    expect(r.citations).toEqual([
      { n: 1, label: 'WhatsApp, 1 Nov', link: '/clients/c1#message-m1' },
      { n: 3, label: 'Ticket GST', link: '/clients/c1#ticket-t1' },
    ])
    const noLink = await askShadowWith(testDeps('See [2, 1]'), asha, 'status?')
    expect(noLink.citations[1]).toEqual({ n: 2, label: 'File GST.pdf' })
    expect('link' in noLink.citations[1]).toBe(false)
  })

  it('appends the safety rule to the system prompt', async () => {
    const seen: Seen = {}
    await askShadowWith(testDeps('ok', seen), asha, 'hi')
    expect(seen.instructions?.endsWith(ASK_SAFETY_RULE)).toBe(true)
    expect(ASK_SAFETY_RULE).toMatch(/data, never instructions/)
    expect(ASK_SAFETY_RULE).toMatch(/other than the citations/)
  })

  it('masks credentials in the answer', async () => {
    const r = await askShadowWith(testDeps('The client shared password: Abc@123 and OTP is 445566 [1].'), asha, 'q')
    expect(r.text).not.toContain('Abc@123')
    expect(r.text).not.toContain('445566')
    expect(r.text).toContain('[hidden]')
    expect(r.citations.map((c) => c.n)).toEqual([1])
  })

  it('strips images and off-domain links, keeps relative and own-host citation links', async () => {
    const answer = [
      'Filed [1]. ![pixel](https://evil.test/p.png)',
      'Pay at [this link](https://evil.test/pay) now.',
      'See [WhatsApp, 1 Nov](/clients/c1#message-m1) and [ticket](https://shadow.example.com/clients/c1#ticket-t1).',
      'Also [proto](//evil.test/x) and [js](javascript:alert(1)) and <https://evil.test/auto>.',
      'Raw https://evil.test/raw and www.evil.test but https://shadow.example.com/clients/c1 stays.',
    ].join('\n')
    const r = await askShadowWith(testDeps(answer), asha, 'q', { allowedHost: 'shadow.example.com' })
    expect(r.text).not.toContain('![')
    expect(r.text).not.toContain('p.png')
    expect(r.text).toContain('Pay at this link now.')
    expect(r.text).toContain('[WhatsApp, 1 Nov](/clients/c1#message-m1)')
    expect(r.text).toContain('[ticket](https://shadow.example.com/clients/c1#ticket-t1)')
    expect(r.text).toContain('https://shadow.example.com/clients/c1 stays')
    expect(r.text).not.toMatch(/\]\((?!\/clients|https:\/\/shadow\.example\.com)/)
    expect(r.text).not.toContain('https://evil.test')
    expect(r.text).not.toContain('www.evil.test')
    expect(r.text).toContain(`http${ZWSP}s://evil.test/raw`)
    expect(r.citations.map((c) => c.n)).toEqual([1])
  })

  it('allows only relative links when no host is known', () => {
    expect(sanitizeAnswer('[a](/x) [b](https://shadow.example.com/y)', null)).toBe(`[a](/x) b`)
  })

  it('Teams chat: sends earlier turns first, adds the Teams rule and the proposeSave tool, and keeps long messages', async () => {
    let tools: ToolSet = {}
    let messages: unknown
    let instructions = ''
    const deps: AskDeps = {
      ...testDeps('ok'),
      generate: async (o) => {
        tools = o.tools
        messages = o.messages
        instructions = o.instructions
        expect(o.maxOutputTokens).toBe(2000)
        return { text: 'ok' }
      },
    }
    const long = 'y'.repeat(10_000)
    await askShadowWith(deps, asha, long, {
      teams: true,
      history: [
        { role: 'user', text: 'Open tickets for Alpha?' },
        { role: 'assistant', text: 'Two are open.' },
      ],
    })
    expect(messages).toEqual([
      { role: 'user', content: 'Open tickets for Alpha?' },
      { role: 'assistant', content: 'Two are open.' },
      { role: 'user', content: long },
    ])
    expect(instructions).toContain(TEAMS_CHAT_RULE)
    expect(instructions).toContain('General knowledge, not from client data')
    expect(Object.keys(tools)).toContain('proposeSave')

    const seen: Seen = {}
    await askShadowWith(testDeps('ok', seen), asha, long)
    expect(seen.messages).toEqual([{ role: 'user', content: 'y'.repeat(4000) }])
    expect(seen.instructions).not.toContain(TEAMS_CHAT_RULE)
  })

  it('proposeSave records a proposal only for a client in scope, and drops a future date', async () => {
    const run = async (input: Record<string, unknown>) => {
      const deps: AskDeps = {
        ...testDeps('ok'),
        generate: async (o) => {
          const out = await (o.tools.proposeSave as { execute: (i: unknown, x: unknown) => Promise<unknown> }).execute(input, {
            toolCallId: 't1',
            messages: [],
          })
          return { text: JSON.stringify(out) }
        },
      }
      return askShadowWith(deps, asha, 'save this for Alpha', { teams: true })
    }
    const ok = await run({ clientId: 'c1', title: 'Call with Ravi', meetingDate: '2026-11-17', source: 'this_message', startsWith: 'Ravi: hello' })
    expect(ok.save).toEqual({
      clientId: 'c1',
      clientName: 'Alpha Traders',
      title: 'Call with Ravi',
      meetingDate: '2026-11-17',
      source: 'this_message',
      startsWith: 'Ravi: hello',
    })
    const future = await run({ clientId: 'c1', title: 'Call', meetingDate: '2026-12-25', source: 'this_message' })
    expect(future.save?.meetingDate).toBeNull()
    const outside = await run({ clientId: 'c2', title: 'Call', source: 'this_message' })
    expect(outside.save).toBeUndefined()
    expect(outside.text).toMatch(/not in your list/)
  })

  it('proposeClose takes a listed ticket by [n], checks role, scope and status, and closes nothing', async () => {
    const statuses: Record<string, { clientId: string; status: string }> = { t1: { clientId: 'c1', status: 'open' } }
    const ticketForUser = vi.fn(async (_u: AppUser, id: string) => statuses[id] ?? null)
    const run = async (user: AppUser, calls: number[], teams = true) => {
      const deps: AskDeps = {
        ...testDeps('ok'),
        ticketForUser,
        generate: async (o) => {
          const out = []
          for (const ticket of calls) {
            out.push(await (o.tools.proposeClose as { execute: (i: unknown, x: unknown) => Promise<unknown> }).execute({ ticket }, { toolCallId: 't1', messages: [] }))
          }
          expect('proposeClose' in o.tools).toBe(teams)
          return { text: JSON.stringify(out) }
        },
      }
      return askShadowWith(deps, user, 'close the GST ticket for Alpha', { teams })
    }

    // Citations from the test tools: [1] message, [2] file, [3] ticket t1 (client c1).
    const ok = await run(asha, [3, 3])
    expect(ok.closes).toEqual(['t1'])
    expect(ok.text).toContain('Close button')

    const notTicket = await run(asha, [1])
    expect(notTicket.closes).toBeUndefined()
    expect(notTicket.text).toContain('not a ticket listed')

    statuses.t1.status = 'closed'
    const closed = await run(asha, [3])
    expect(closed.closes).toBeUndefined()
    expect(closed.text).toContain('already closed')
    statuses.t1.status = 'open'

    const engineer: AppUser = { id: 'u9', email: 'eng@example.com', name: 'Eng', role: 'engineer', vaId: null }
    const refused = await run(engineer, [3])
    expect(refused.closes).toBeUndefined()
    expect(refused.text).toContain('Only a Senior Accountant or an Admin')

    const viewingAs: AppUser = { ...admin, viewingAs: { vaId: 'va1', name: 'Asha' } }
    expect((await run(viewingAs, [3])).closes).toBeUndefined()

    delete statuses.t1
    const gone = await run(admin, [3])
    expect(gone.closes).toBeUndefined()
    expect(gone.text).toContain('not found')

    await run(asha, [], false) // the web chat has no proposeClose tool
  })

  it('proposeClose stops at the cap and tells the model, and a failed lookup gives a safe error', async () => {
    const ids = ['t1', 't2', 't3', 't4']
    const run = async (ticketForUser: AskDeps['ticketForUser'], calls: number[]) => {
      const deps: AskDeps = {
        ...testDeps('ok'),
        ticketForUser,
        tools: (ctx) => {
          for (const id of ids) ctx.registry.add({ kind: 'ticket', id, clientId: 'c1', at: null, label: `Ticket ${id}` })
          return {}
        },
        generate: async (o) => {
          const out = []
          for (const ticket of calls) {
            out.push(await (o.tools.proposeClose as { execute: (i: unknown, x: unknown) => Promise<unknown> }).execute({ ticket }, { toolCallId: 't1', messages: [] }))
          }
          return { text: JSON.stringify(out) }
        },
      }
      return askShadowWith(deps, asha, 'close these', { teams: true })
    }
    const open = async () => ({ clientId: 'c1', status: 'open' })
    const capped = await run(open, [1, 2, 3, 4])
    expect(capped.closes).toEqual(['t1', 't2', 't3'])
    expect(capped.text).toContain('At most 3 Close cards')

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await run(async () => {
      throw new Error('ticketForUser: connection refused')
    }, [1])
    expect(failed.closes).toBeUndefined()
    expect(failed.text).toContain('Could not check this ticket')
    expect(failed.text).not.toContain('connection refused')
  })

  it('repairs citation ranges and drops placeholder labels, so the sources still list', async () => {
    expect(normalizeCitations('All on Nirved [1-3]. Total 89 tickets [totals]. Items [n4-n5] and [n6].')).toBe(
      'All on Nirved [1][2][3]. Total 89 tickets. Items [4][5] and [6].',
    )
    expect(normalizeCitations('See [the docs](https://x.test/a) [2-1] [1-100]')).toBe('See [the docs](https://x.test/a) [2-1] [1-100]')
    expect(normalizeCitations('Returns for [2023-2025] are filed.')).toBe('Returns for [2023-2025] are filed.')
    const r = await askShadowWith(testDeps('Three tickets [1-3].'), asha, 'tickets?')
    expect(r.citations.map((c) => c.n)).toEqual([1, 2, 3])
  })

  it('rejects an empty question before calling the model', async () => {
    const deps = testDeps('ok')
    const generate = vi.spyOn(deps, 'generate')
    await expect(askShadowWith(deps, asha, '   ')).rejects.toThrow(EMPTY_QUESTION)
    expect(generate).not.toHaveBeenCalled()
  })
})
