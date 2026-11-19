import { describe, expect, it } from 'vitest'
import type { AppUser } from '@/lib/auth/types'
import { buildRoutes, loadRoutes } from './routing'
import type { PersonalChats, TeamsChannelMap } from './types'

const SVC = 'https://smba.trafficmanager.net/in/'
const chat = (id: string) => ({ conversationId: id, serviceUrl: SVC, name: null, at: '' })
const people: Record<string, AppUser> = {
  'asha@x.in': { id: 'u1', email: 'asha@x.in', name: 'Asha', role: 'senior_accountant', vaId: 'va1' },
  'raghav@x.in': { id: 'u2', email: 'raghav@x.in', name: 'Raghav', role: 'admin', vaId: null },
  'eng@x.in': { id: 'u3', email: 'eng@x.in', name: 'Eng', role: 'engineer', vaId: null },
  'nova@x.in': { id: 'u4', email: 'nova@x.in', name: 'Nova', role: 'senior_accountant', vaId: null },
}
const resolve = async (email: string) => people[email] ?? null
const MAP: TeamsChannelMap = {
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  tenantId: 't',
  teamId: 'team',
  accountants: { va1: { id: 'ch-va1', name: 'Asha tickets' }, va2: { id: 'ch-va2', name: 'Bala tickets' } },
  escalations: { id: 'ch-esc', name: 'Escalations' },
}

describe('buildRoutes', () => {
  it('1:1 chats win over channels: accountant to their own chat, escalations to Admins and Engineers', async () => {
    const chats: PersonalChats = { 'asha@x.in': chat('a:asha'), 'raghav@x.in': chat('a:raghav'), 'eng@x.in': chat('a:eng') }
    const r = await buildRoutes(MAP, chats, resolve)
    expect(r.accountant('va1')).toEqual({ id: 'a:asha', name: 'Asha (1:1)', serviceUrl: SVC })
    expect(r.accountant('va2')).toEqual({ id: 'ch-va2', name: 'Bala tickets', serviceUrl: MAP.serviceUrl })
    expect(r.accountant('va9')).toBeNull()
    expect(r.accountant(null)).toBeNull()
    expect(r.escalations().map((t) => t.id)).toEqual(['a:raghav', 'a:eng'])
    expect(r.any).toBe(true)
    expect(r.skipped).toEqual([])
  })

  it('falls back to the Escalations channel when no Admin or Engineer has a chat', async () => {
    const r = await buildRoutes(MAP, { 'asha@x.in': chat('a:asha') }, resolve)
    expect(r.escalations()).toEqual([{ id: 'ch-esc', name: 'Escalations', serviceUrl: MAP.serviceUrl }])
  })

  it('skips people without access or whose lookup fails, and a Senior Accountant with no accountant record', async () => {
    const chats: PersonalChats = { 'gone@x.in': chat('a:gone'), 'nova@x.in': chat('a:nova'), 'boom@x.in': chat('a:boom') }
    const r = await buildRoutes(null, chats, async (email) => {
      if (email === 'boom@x.in') throw new Error('auth down')
      return resolve(email)
    })
    expect(r.skipped).toEqual(['gone@x.in: no access', 'boom@x.in: lookup failed (auth down)'])
    expect(r.escalations()).toEqual([])
    expect(r.any).toBe(false)
    expect(r.lookupFailed).toBe(true)
    expect((await buildRoutes(null, { 'gone@x.in': chat('a:gone') }, resolve)).lookupFailed).toBe(false)
  })

  it('never routes to someone viewing as another accountant', async () => {
    const viewer: AppUser = { ...people['raghav@x.in'], viewingAs: { vaId: 'va1', name: 'Asha' } }
    const r = await buildRoutes(null, { 'raghav@x.in': chat('a:raghav') }, async () => viewer)
    expect(r.escalations()).toEqual([])
  })

  it('nothing stored and nothing linked means nowhere to send', async () => {
    expect((await buildRoutes(null, {}, resolve)).any).toBe(false)
    expect((await buildRoutes({ ...MAP, accountants: {}, escalations: null }, {}, resolve)).any).toBe(false)
  })

  it('loadRoutes reads the channel map, the chats and the accountants from the store', async () => {
    const r = await loadRoutes({
      store: {
        channels: async () => MAP,
        personalChats: async () => ({ 'asha@x.in': chat('a:asha') }),
        accountants: async () => [{ vaId: 'va1', name: 'Asha', email: 'Asha@X.in', teamsUserId: null }],
      },
      resolveUser: resolve,
    })
    expect(r.accountant('va1')?.id).toBe('a:asha')
  })

  it('an accountant who uses the 1:1 chat never falls back to a shared channel, even when their chat cannot be used', async () => {
    const vaEmails = new Map([['va1', 'asha@x.in']])
    const failed = await buildRoutes(MAP, { 'asha@x.in': chat('a:asha') }, async () => Promise.reject(new Error('down')), vaEmails)
    expect(failed.accountant('va1')).toBeNull()
    const removed = await buildRoutes(MAP, { 'asha@x.in': chat('a:asha') }, async () => null, vaEmails)
    expect(removed.accountant('va1')).toBeNull()
    // No stored chat: the channel is still used.
    expect((await buildRoutes(MAP, {}, resolve, vaEmails)).accountant('va1')?.id).toBe('ch-va1')
  })
})
