import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => {
    throw new Error('the real database must not be used in tests')
  },
}))

import type { GuideStore } from './guide-store'
import { isDue, REBUILD_AFTER_DAYS, runStyleGuideJob } from './guide-job'
import type { StoredGuide } from './style-guide'

const NOW = new Date('2026-11-28T00:00:00Z')
const COMPLETE = '# Style guide\n\n## 1. Client\n## 7. Phrase bank\n- Noted sir'

function stored(builtAt: string, version = 1): StoredGuide {
  return { guide: COMPLETE, version, model: 'm', builtAt, messages: 10, corrections: 0 }
}

function row(id: string, at: string, direction: 'incoming' | 'outgoing', body: string) {
  return {
    message_id: id,
    dedup_hash: id,
    message_timestamp: at,
    body,
    sender_name: null,
    sender_phone: null,
    direction,
    message_type: 'chat',
    conversation_id: null,
  }
}

function fakeStore(guides: Record<string, StoredGuide | null>, pilot = Object.keys(guides)) {
  const saved: { id: string; guide: StoredGuide }[] = []
  const store: GuideStore = {
    pilotClients: async () => pilot,
    clientNames: async (ids) => new Map(ids.map((id) => [id, `Client ${id}`])),
    guide: async (id) => guides[id] ?? null,
    messages: async () => [
      row('m1', '2026-11-27T05:00:00Z', 'incoming', 'Pls share GST working'),
      row('m2', '2026-11-27T05:05:00Z', 'outgoing', 'Sure sir'),
    ],
    corrections: async () => [{ draft: 'Will check', finalText: 'Done sir' }],
    saveGuide: async (id, _name, guide) => {
      saved.push({ id, guide })
    },
  }
  return { store, saved }
}

describe('isDue', () => {
  it('is due when missing or older than the rebuild window', () => {
    expect(isDue(null, NOW.getTime())).toBe(true)
    expect(isDue(stored('2026-11-27T00:00:00Z'), NOW.getTime())).toBe(false)
    expect(isDue(stored(new Date(NOW.getTime() - REBUILD_AFTER_DAYS * 86_400_000).toISOString()), NOW.getTime())).toBe(true)
    expect(isDue(stored('bad'), NOW.getTime())).toBe(true)
  })
})

describe('runStyleGuideJob', () => {
  it('a dry run lists due clients and makes no model calls', async () => {
    const { store, saved } = fakeStore({ a: null, b: stored('2026-11-27T00:00:00Z') })
    const generate = vi.fn()
    const r = await runStyleGuideJob({ write: false, now: NOW }, { store, generate, teamNumbers: new Set() })
    expect(generate).not.toHaveBeenCalled()
    expect(saved).toEqual([])
    const outcomes = (r.details as { outcomes: { clientId: string; status: string }[] }).outcomes
    expect(outcomes.find((x) => x.clientId === 'a')?.status).toBe('would_rebuild')
    expect(outcomes.find((x) => x.clientId === 'b')?.status).toBe('up_to_date')
  })

  it('a write run rebuilds due guides with the corrections and bumps the version', async () => {
    const { store, saved } = fakeStore({ a: stored('2026-11-01T00:00:00Z', 4) })
    const generate = vi.fn<(system: string, prompt: string) => Promise<string>>(async () => COMPLETE)
    const r = await runStyleGuideJob({ write: true, now: NOW }, { store, generate, modelId: 'opus', teamNumbers: new Set() })
    expect(r).toMatchObject({ written: 1, errors: [] })
    expect(saved[0]).toMatchObject({
      id: 'a',
      guide: { version: 5, model: 'opus', builtAt: NOW.toISOString(), corrections: 1, messages: 2 },
    })
    expect(saved[0].guide.guide.startsWith('## 1.')).toBe(true)
    expect(generate.mock.calls[0][1]).toContain('Sent instead: Done sir')
  })

  it('keeps the old guide when the new one is cut off', async () => {
    const { store, saved } = fakeStore({ a: null })
    const r = await runStyleGuideJob({ write: true, now: NOW }, { store, generate: async () => '## 1. Only part', teamNumbers: new Set() })
    expect(saved).toEqual([])
    expect(r.errors[0]).toContain('cut off')
  })

  it('force rebuilds a recent guide; clientIds limits to those pilot clients', async () => {
    const { store, saved } = fakeStore({ a: stored('2026-11-27T00:00:00Z'), b: stored('2026-11-27T00:00:00Z') })
    await runStyleGuideJob(
      { write: true, now: NOW, force: true, clientIds: ['b', 'zzz'] },
      { store, generate: async () => COMPLETE, teamNumbers: new Set() },
    )
    expect(saved.map((s) => s.id)).toEqual(['b'])
  })

  it('stops starting new clients when the time budget is used', async () => {
    const { store, saved } = fakeStore({ a: null, b: null })
    let t = 0
    const r = await runStyleGuideJob(
      { write: true, now: NOW, budgetMs: 100 },
      {
        store,
        generate: async () => {
          t += 200
          return COMPLETE
        },
        clock: () => t,
        teamNumbers: new Set(),
      },
    )
    expect(saved).toHaveLength(1)
    expect((r.details as { outcomes: { status: string }[] }).outcomes.map((o) => o.status)).toContain('deferred')
  })

  it('does nothing without a pilot list', async () => {
    const { store } = fakeStore({}, [])
    const r = await runStyleGuideJob({ write: true, now: NOW }, { store, generate: vi.fn(), teamNumbers: new Set() })
    expect(r).toMatchObject({ processed: 0, written: 0 })
  })
})
