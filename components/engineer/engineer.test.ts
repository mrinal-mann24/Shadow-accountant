import { describe, expect, it } from 'vitest'
import { BASE_URL_PLACEHOLDER, jobHints, normaliseBaseUrl } from './job-hints'
import { percentile, summariseVerdicts, type VerdictRow } from '@/lib/data/usage'
import { formatLatency } from './usage'

function verdict(over: Partial<VerdictRow>): VerdictRow {
  return {
    created_at: '2026-11-10T10:00:00.000Z',
    agreed: true,
    final_decision: 'continue',
    claude_model: 'anthropic/claude-sonnet-5',
    claude_latency_ms: 1000,
    gpt_model: 'openai/gpt-5.6-luna',
    gpt_latency_ms: 2000,
    ...over,
  }
}

describe('summariseVerdicts', () => {
  it('returns an empty summary for no rows', () => {
    expect(summariseVerdicts([], 30)).toEqual({
      windowDays: 30,
      verdicts: 0,
      agreedPct: null,
      byDecision: [],
      models: [],
      lastVerdictAt: null,
    })
  })

  it('counts decisions, agreement, per-model calls and latency', () => {
    const rows = [
      verdict({ created_at: '2026-11-10T10:00:00.000Z', claude_latency_ms: 1000, gpt_latency_ms: 3000 }),
      verdict({ created_at: '2026-11-12T10:00:00.000Z', agreed: false, final_decision: 'no_action', claude_latency_ms: 3000, gpt_latency_ms: null }),
      verdict({ created_at: '2026-11-11T10:00:00.000Z', final_decision: 'new', claude_model: 'anthropic/claude-old', claude_latency_ms: 500 }),
    ]
    const s = summariseVerdicts(rows, 30)
    expect(s.verdicts).toBe(3)
    expect(s.agreedPct).toBe(66.7)
    expect(s.lastVerdictAt).toBe('2026-11-12T10:00:00.000Z')
    expect(s.byDecision).toEqual([
      { decision: 'continue', count: 1 },
      { decision: 'new', count: 1 },
      { decision: 'no_action', count: 1 },
    ])
    expect(s.models).toEqual([
      { slot: 'A', model: 'anthropic/claude-sonnet-5', calls: 2, avgLatencyMs: 2000, p95LatencyMs: 3000 },
      { slot: 'A', model: 'anthropic/claude-old', calls: 1, avgLatencyMs: 500, p95LatencyMs: 500 },
      // null latency counts as a call but not in the averages
      { slot: 'B', model: 'openai/gpt-5.6-luna', calls: 3, avgLatencyMs: 2500, p95LatencyMs: 3000 },
    ])
  })
})

describe('percentile and formatLatency', () => {
  it('uses nearest rank', () => {
    expect(percentile([], 95)).toBeNull()
    expect(percentile([5], 95)).toBe(5)
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95)
    expect(percentile([10, 1, 5], 50)).toBe(5)
  })

  it('formats latency', () => {
    expect(formatLatency(null)).toBe('None')
    expect(formatLatency(850.4)).toBe('850 ms')
    expect(formatLatency(12_345)).toBe('12.3 s')
  })
})

describe('jobHints', () => {
  it('normalises the base URL', () => {
    expect(normaliseBaseUrl(null)).toBe(BASE_URL_PLACEHOLDER)
    expect(normaliseBaseUrl('  ')).toBe(BASE_URL_PLACEHOLDER)
    expect(normaliseBaseUrl('shadow.example.com/')).toBe('https://shadow.example.com')
    expect(normaliseBaseUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('builds one curl per job with the secret as a shell variable, never a value', () => {
    const hints = jobHints('https://shadow.example.com')
    expect(hints.map((h) => h.key)).toEqual(['health-score', 'council', 'hubspot-sync', 'embed'])
    for (const h of hints) {
      expect(h.command).toContain('-H "Authorization: Bearer $CRON_SECRET"')
      expect(h.command).toContain(`https://shadow.example.com/api/jobs/${h.key}`)
    }
    expect(hints[1].command).toContain('/api/jobs/council?limit=25')
  })
})
