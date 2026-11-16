// Pure: curl commands an engineer can run to trigger each batch job by hand. Client-safe, unit tested.
// The secret is never filled in: commands use the shell variable $CRON_SECRET.
// Schedules mirror vercel.json; keep them in step.

export type JobHint = { key: string; label: string; schedule: string; description: string; command: string }

export const BASE_URL_PLACEHOLDER = 'https://<app-host>'

const JOBS: Omit<JobHint, 'command'>[] = [
  {
    key: 'health-score',
    label: 'Health score',
    schedule: 'Daily at 7:00 am IST (01:30 UTC)',
    description: 'Scores every client. Add ?clientIds=a,b to score only those clients.',
  },
  {
    key: 'council',
    label: 'Ticket council',
    schedule: 'Every 15 minutes',
    description:
      'Two models vote on unprocessed messages of council clients. ?limit=25 messages per run (max 100). ' +
      'A dry run only lists the messages; add &vote=1 to call both models.',
  },
  {
    key: 'hubspot-sync',
    label: 'HubSpot sync',
    schedule: 'Every 30 minutes',
    description: 'Pulls deal stage and amount, pushes accountant, health score and open tickets.',
  },
  {
    key: 'embed',
    label: 'Message embeddings',
    schedule: 'Every hour',
    description: 'Embeds messages for Ask AI search. ?limit= per run (default and max 100). Dry run reports counts only.',
  },
]

/** Normalises a base URL ("example.com", "https://example.com/") to "https://example.com"; placeholder when empty. */
export function normaliseBaseUrl(raw: string | null | undefined): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '')
  if (!value) return BASE_URL_PLACEHOLDER
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

export function jobHints(baseUrl: string | null | undefined): JobHint[] {
  const base = normaliseBaseUrl(baseUrl)
  return JOBS.map((j) => ({
    ...j,
    command: `curl -s -H "Authorization: Bearer $CRON_SECRET" "${base}/api/jobs/${j.key}${j.key === 'council' ? '?limit=25' : ''}"`,
  }))
}
