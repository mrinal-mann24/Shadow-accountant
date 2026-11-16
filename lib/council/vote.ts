import 'server-only'
import { generateObject } from 'ai'
import { getModel, getModelId, type ModelSlot } from '@/lib/ai/openrouter'
import { COUNCIL_SYSTEM_PROMPT } from './prompt'
import { voteSchema, type Vote } from './types'

export type ModelVote = { vote: Vote; model: string; latencyMs: number }
export type VoteFn = (which: ModelSlot, prompt: string) => Promise<ModelVote>

export const MODEL_TIMEOUT_MS = 60_000

/** One structured vote from one model, single attempt with a timeout. The job retries once. */
export const askModel: VoteFn = async (which, prompt) => {
  const model = getModel(which)
  const modelId = getModelId(which)
  const started = Date.now()
  const { object } = await generateObject({
    model,
    schema: voteSchema,
    schemaName: 'council_vote',
    system: COUNCIL_SYSTEM_PROMPT,
    prompt,
    temperature: 0,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  })
  return { vote: object, model: modelId, latencyMs: Date.now() - started }
}

/** Calls fn, and once more if it throws. */
export async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return await fn()
  }
}
