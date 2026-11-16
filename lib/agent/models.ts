import 'server-only'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { embedMany, type EmbeddingModel } from 'ai'

// Embeddings for client_messages.embedding (vector(1536)) via OpenRouter. The chat model itself comes from
// lib/ai/openrouter.ts (getModel('A')). Env is read at call time, never at import.

export const EMBED_DIMS = 1536
const MAX_INPUT_CHARS = 8000

function read(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

export function embedModelId(): string | undefined {
  return read('OPENROUTER_EMBED_MODEL')
}

let provider: ReturnType<typeof createOpenRouter> | null = null

export function getEmbeddingModel(): EmbeddingModel {
  const id = embedModelId()
  if (!id) throw new Error('OPENROUTER_EMBED_MODEL is not set. Set it to an OpenRouter embedding model that returns 1536 dimensions.')
  if (!provider) {
    const apiKey = read('OPENROUTER_API_KEY')
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.')
    provider = createOpenRouter({ apiKey })
  }
  return provider.textEmbeddingModel(id)
}

/** Throws a clear error unless every vector has exactly `dims` numbers. */
export function assertDims(vectors: number[][], dims: number, modelId: string): void {
  const bad = vectors.find((v) => v.length !== dims)
  if (bad) {
    throw new Error(
      `Embedding model ${modelId} returned ${bad.length} dimensions; client_messages.embedding needs ${dims}. ` +
        'Pick a 1536 dimension model for OPENROUTER_EMBED_MODEL.',
    )
  }
}

/** pgvector text form: "[0.1,0.2,...]". */
export function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`
}

/** Embeds texts (cut to 8000 characters each) and checks the dimension count. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const model = getEmbeddingModel()
  const { embeddings } = await embedMany({
    model,
    values: texts.map((t) => t.slice(0, MAX_INPUT_CHARS)),
    maxRetries: 1,
  })
  assertDims(embeddings, EMBED_DIMS, embedModelId() ?? 'unknown')
  return embeddings
}
