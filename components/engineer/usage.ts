// Display helper for the AI usage card. The summary itself lives in lib/data/usage.ts (getCouncilUsage).

/** "850 ms", "12.3 s", or "None". */
export function formatLatency(ms: number | null): string {
  if (ms === null) return 'None'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${Math.round(ms / 100) / 10} s`
}
