import 'server-only'
import { maskCredentials } from '@/lib/ai/redact'
import type { JobResult } from '@/lib/jobs/guard'
import { EMBED_DIMS, embedModelId, embedTexts, toPgVector } from './models'
import { supabaseEmbedStore, type EmbedStore } from './store'

// Embeds client_messages that have text and no embedding, one batch per run (default and max 100).
// Dry run: counts only, no model call and no write.

export const EMBED_BATCH = 100

export type EmbedDeps = { store: EmbedStore; embed: (texts: string[]) => Promise<number[][]>; modelId: () => string | undefined }

const defaultDeps: EmbedDeps = { store: supabaseEmbedStore, embed: embedTexts, modelId: embedModelId }

export function parseEmbedLimit(raw: string | null): number {
  const n = Number(raw)
  if (!raw || !Number.isFinite(n) || n < 1) return EMBED_BATCH
  return Math.min(Math.floor(n), EMBED_BATCH)
}

export async function runEmbedJob(o: { write: boolean; limit?: number }, deps: Partial<EmbedDeps> = {}): Promise<JobResult> {
  const d: EmbedDeps = { ...defaultDeps, ...deps }
  const limit = Math.min(Math.max(1, Math.floor(o.limit ?? EMBED_BATCH)), EMBED_BATCH)
  const pending = await d.store.countPending()
  const base = { job: 'embed', dryRun: !o.write }

  if (!o.write) {
    return {
      ...base,
      processed: 0,
      written: 0,
      errors: [],
      details: { pending, wouldEmbed: Math.min(pending, limit), model: d.modelId() ?? null, dims: EMBED_DIMS },
    }
  }

  const model = d.modelId()
  if (!model) {
    return { ...base, processed: 0, written: 0, errors: ['OPENROUTER_EMBED_MODEL is not set.'], details: { pending } }
  }
  const rows = (await d.store.fetchPending(limit)).filter((r) => r.body.trim().length > 0)
  if (rows.length === 0) return { ...base, processed: 0, written: 0, errors: [], details: { pending, model } }

  let vectors: number[][]
  try {
    // Credential values never leave for the embedding model (CLAUDE.md hard rule).
    vectors = await d.embed(rows.map((r) => maskCredentials(r.body)))
  } catch (e) {
    // A wrong dimension count lands here too (assertDims), with a clear message. Nothing is written.
    return { ...base, processed: rows.length, written: 0, errors: [e instanceof Error ? e.message : String(e)], details: { pending, model } }
  }
  if (vectors.length !== rows.length) {
    return {
      ...base,
      processed: rows.length,
      written: 0,
      errors: [`Embedding model returned ${vectors.length} vectors for ${rows.length} messages.`],
      details: { pending, model },
    }
  }
  const bad = vectors.find((v) => v.length !== EMBED_DIMS)
  if (bad) {
    return {
      ...base,
      processed: rows.length,
      written: 0,
      errors: [`Embedding model ${model} returned ${bad.length} dimensions; client_messages.embedding needs ${EMBED_DIMS}.`],
      details: { pending, model },
    }
  }

  const errors: string[] = []
  let written = 0
  for (let i = 0; i < rows.length; i++) {
    try {
      await d.store.saveEmbedding(rows[i].message_id, toPgVector(vectors[i]))
      written++
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  return { ...base, processed: rows.length, written, errors, details: { pending: pending - written, model } }
}
