import { describe, expect, it, vi } from 'vitest'
import { EMBED_BATCH, parseEmbedLimit, runEmbedJob } from './embed'
import { assertDims, toPgVector } from './models'
import type { EmbedStore } from './store'

function store(pending: { message_id: string; body: string }[]): EmbedStore & { saved: [string, string][] } {
  const saved: [string, string][] = []
  return {
    saved,
    countPending: vi.fn(async () => pending.length),
    fetchPending: vi.fn(async (limit: number) => pending.slice(0, limit)),
    saveEmbedding: vi.fn(async (id: string, v: string) => {
      saved.push([id, v])
    }),
  }
}

const vec = (n: number, fill = 0.5) => Array.from({ length: n }, () => fill)

describe('runEmbedJob', () => {
  it('dry run returns counts only: no model call, no write', async () => {
    const s = store([{ message_id: 'm1', body: 'hi' }])
    const embed = vi.fn()
    const r = await runEmbedJob({ write: false }, { store: s, embed, modelId: () => 'openai/text-embedding-3-small' })
    expect(r).toMatchObject({ job: 'embed', dryRun: true, processed: 0, written: 0, errors: [] })
    expect(r.details).toMatchObject({ pending: 1, wouldEmbed: 1, dims: 1536 })
    expect(embed).not.toHaveBeenCalled()
    expect(s.fetchPending).not.toHaveBeenCalled()
  })

  it('write mode embeds the batch and saves pgvector text', async () => {
    const s = store([
      { message_id: 'm1', body: 'gst filed' },
      { message_id: 'm2', body: '   ' },
      { message_id: 'm3', body: 'bank statement' },
    ])
    const embed = vi.fn(async (texts: string[]) => texts.map(() => vec(1536, 0.25)))
    const r = await runEmbedJob({ write: true }, { store: s, embed, modelId: () => 'm' })
    expect(embed).toHaveBeenCalledWith(['gst filed', 'bank statement'])
    expect(r).toMatchObject({ dryRun: false, processed: 2, written: 2, errors: [] })
    expect(s.saved.map(([id]) => id)).toEqual(['m1', 'm3'])
    expect(s.saved[0][1].startsWith('[0.25,0.25')).toBe(true)
  })

  it('fails clearly and writes nothing when the model returns the wrong dimension count', async () => {
    const s = store([{ message_id: 'm1', body: 'x' }])
    const r = await runEmbedJob({ write: true }, { store: s, embed: async () => [vec(3072)], modelId: () => 'big-model' })
    expect(r.written).toBe(0)
    expect(r.errors[0]).toBe('Embedding model big-model returned 3072 dimensions; client_messages.embedding needs 1536.')
    expect(s.saved).toEqual([])
  })

  it('write mode without a model set reports it and does nothing', async () => {
    const s = store([{ message_id: 'm1', body: 'x' }])
    const r = await runEmbedJob({ write: true }, { store: s, embed: vi.fn(), modelId: () => undefined })
    expect(r.errors).toEqual(['OPENROUTER_EMBED_MODEL is not set.'])
    expect(s.fetchPending).not.toHaveBeenCalled()
  })

  it('caps the batch at 100 and keeps going when one save fails', async () => {
    const pending = Array.from({ length: 150 }, (_, i) => ({ message_id: `m${i}`, body: `b${i}` }))
    const s = store(pending)
    s.saveEmbedding = vi.fn(async (id: string) => {
      if (id === 'm5') throw new Error('saveEmbedding m5: timeout')
    })
    const r = await runEmbedJob({ write: true, limit: 500 }, { store: s, embed: async (t) => t.map(() => vec(1536)), modelId: () => 'm' })
    expect(s.fetchPending).toHaveBeenCalledWith(EMBED_BATCH)
    expect(r).toMatchObject({ processed: 100, written: 99, errors: ['saveEmbedding m5: timeout'] })
  })

  it('reports a model error without writing', async () => {
    const s = store([{ message_id: 'm1', body: 'x' }])
    const r = await runEmbedJob({ write: true }, { store: s, embed: async () => Promise.reject(new Error('429 rate limited')), modelId: () => 'm' })
    expect(r).toMatchObject({ written: 0, errors: ['429 rate limited'] })
  })
})

describe('helpers', () => {
  it('parseEmbedLimit defaults to and caps at 100', () => {
    expect(parseEmbedLimit(null)).toBe(100)
    expect(parseEmbedLimit('abc')).toBe(100)
    expect(parseEmbedLimit('25')).toBe(25)
    expect(parseEmbedLimit('1000')).toBe(100)
  })
  it('assertDims names the model and both sizes', () => {
    expect(() => assertDims([vec(1536)], 1536, 'm')).not.toThrow()
    expect(() => assertDims([vec(1536), vec(768)], 1536, 'small')).toThrow(/small returned 768 dimensions; client_messages.embedding needs 1536/)
  })
  it('toPgVector', () => {
    expect(toPgVector([1, 0.5, -2])).toBe('[1,0.5,-2]')
  })
})
