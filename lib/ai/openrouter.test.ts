import { afterEach, describe, expect, it, vi } from 'vitest'
import { getModel, getModelId } from './openrouter'

afterEach(() => vi.unstubAllEnvs())

describe('getModelId', () => {
  it('reads OPENROUTER_MODEL_A and _B', () => {
    vi.stubEnv('OPENROUTER_MODEL_A', ' anthropic/claude-sonnet-5 ')
    vi.stubEnv('OPENROUTER_MODEL_B', 'openai/gpt-5.6-luna')
    expect(getModelId('A')).toBe('anthropic/claude-sonnet-5')
    expect(getModelId('B')).toBe('openai/gpt-5.6-luna')
  })

  it('throws a clear error when unset or blank', () => {
    vi.stubEnv('OPENROUTER_MODEL_A', '')
    expect(() => getModelId('A')).toThrow(/OPENROUTER_MODEL_A is not set/)
  })
})

describe('getModel', () => {
  it('throws when the API key is missing', () => {
    vi.stubEnv('OPENROUTER_MODEL_B', 'openai/gpt-5.6-luna')
    vi.stubEnv('OPENROUTER_API_KEY', '')
    expect(() => getModel('B')).toThrow(/OPENROUTER_API_KEY is not set/)
  })
})
