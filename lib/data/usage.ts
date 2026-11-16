// Pure AI usage summary over council_verdicts rows (behind getCouncilUsage). Client-safe, unit tested.
// Moved here from components/engineer/usage.ts by the integrator.
// Cost is not tracked: council_verdicts stores model ids and latency only.

export type VerdictRow = {
  created_at: string
  agreed: boolean | null
  final_decision: string
  claude_model: string
  claude_latency_ms: number | null
  gpt_model: string
  gpt_latency_ms: number | null
}

export type ModelUsage = {
  /** A = OPENROUTER_MODEL_A (stored in claude_*), B = OPENROUTER_MODEL_B (stored in gpt_*). */
  slot: 'A' | 'B'
  model: string
  calls: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
}

export type CouncilUsage = {
  windowDays: number
  verdicts: number
  /** Share of verdicts where both models agreed, 0 to 100, 1 decimal; null when there are none. */
  agreedPct: number | null
  byDecision: { decision: string; count: number }[]
  models: ModelUsage[]
  /** Newest created_at in the rows, or null. */
  lastVerdictAt: string | null
}

export function summariseVerdicts(rows: VerdictRow[], windowDays: number): CouncilUsage {
  const decisions = new Map<string, number>()
  const models = new Map<string, { slot: 'A' | 'B'; model: string; latencies: number[]; calls: number }>()
  let agreed = 0
  let last: string | null = null

  const add = (slot: 'A' | 'B', model: string, latency: number | null) => {
    const key = `${slot}:${model}`
    const m = models.get(key) ?? { slot, model, latencies: [], calls: 0 }
    m.calls++
    if (latency !== null && Number.isFinite(latency)) m.latencies.push(latency)
    models.set(key, m)
  }

  for (const r of rows) {
    decisions.set(r.final_decision, (decisions.get(r.final_decision) ?? 0) + 1)
    if (r.agreed) agreed++
    if (!last || r.created_at > last) last = r.created_at
    add('A', r.claude_model, r.claude_latency_ms)
    add('B', r.gpt_model, r.gpt_latency_ms)
  }

  return {
    windowDays,
    verdicts: rows.length,
    agreedPct: rows.length ? Math.round((agreed / rows.length) * 1000) / 10 : null,
    byDecision: [...decisions]
      .map(([decision, count]) => ({ decision, count }))
      .sort((a, b) => b.count - a.count || a.decision.localeCompare(b.decision)),
    models: [...models.values()]
      .map((m) => ({
        slot: m.slot,
        model: m.model,
        calls: m.calls,
        avgLatencyMs: m.latencies.length
          ? Math.round(m.latencies.reduce((s, x) => s + x, 0) / m.latencies.length)
          : null,
        p95LatencyMs: percentile(m.latencies, 95),
      }))
      .sort((a, b) => a.slot.localeCompare(b.slot) || b.calls - a.calls),
    lastVerdictAt: last,
  }
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}
