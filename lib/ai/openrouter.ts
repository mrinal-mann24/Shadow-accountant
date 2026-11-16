import 'server-only'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'

// Two council models. A is the Anthropic model (stored in council_verdicts.claude_*),
// B is the other model (stored in council_verdicts.gpt_*). Read at call time, never at import.

export type ModelSlot = 'A' | 'B'

function read(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

/** The OpenRouter model id for a slot, for example "anthropic/claude-sonnet-5". Throws if unset. */
export function getModelId(which: ModelSlot): string {
  const name = which === 'A' ? 'OPENROUTER_MODEL_A' : 'OPENROUTER_MODEL_B'
  const id = read(name)
  if (!id) throw new Error(`${name} is not set. Set it to an OpenRouter model id, for example anthropic/claude-sonnet-5.`)
  return id
}

let provider: ReturnType<typeof createOpenRouter> | null = null

export function getModel(which: ModelSlot): LanguageModel {
  const id = getModelId(which)
  if (!provider) {
    const apiKey = read('OPENROUTER_API_KEY')
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.')
    provider = createOpenRouter({ apiKey })
  }
  return provider.chat(id)
}
