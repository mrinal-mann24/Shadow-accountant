import { z } from 'zod'

// Lazy: nothing is validated at import time, so `next build` works with no env set.
// Call serverEnv() inside request handlers / jobs, never at module top level.

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))

const required = (name: string) =>
  z.string({ error: `${name} is not set` }).trim().min(1, `${name} is not set`)

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: required('NEXT_PUBLIC_SUPABASE_URL').pipe(z.url()),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
  OPENROUTER_API_KEY: optional,
  OPENROUTER_MODEL_A: optional,
  OPENROUTER_MODEL_B: optional,
  OPENROUTER_EMBED_MODEL: optional,
  CRON_SECRET: optional,
  JOBS_WRITE_ENABLED: optional.transform((v) => v?.toLowerCase() === 'true'),
  HUBSPOT_ACCESS_TOKEN: optional,
  HUBSPOT_WEBHOOK_SECRET: optional,
  DEV_LOGIN_EMAIL: optional,
  APP_TIMEZONE: optional.transform((v) => v ?? 'Asia/Kolkata'),
})

export type ServerEnv = z.infer<typeof serverSchema>

let cached: ServerEnv | null = null

/** Validated server env. Throws an Error naming every missing or invalid variable. Server only. */
export function serverEnv(): ServerEnv {
  if (cached) return cached
  const parsed = serverSchema.safeParse(process.env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`)
  }
  cached = parsed.data
  return cached
}

export type PublicEnv = { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string }

/** App timezone (IANA). Same default as serverEnv().APP_TIMEZONE, without validating the whole env. */
export function appTimezone(): string {
  return process.env.APP_TIMEZONE?.trim() || 'Asia/Kolkata'
}

// Deliberate direct process.env reads elsewhere (each fails closed when unset): CRON_SECRET, JOBS_WRITE_* (lib/jobs/guard.ts),
// HUBSPOT_WEBHOOK_SECRET (app/api/webhooks/hubspot), HUBSPOT_PUSH_ENABLED (lib/hubspot/sync.ts), DEV_LOGIN_* (lib/auth),
// NEXT_PUBLIC_SITE_URL (login), COUNCIL_START_DATE (council route), HEALTH_SCORE_PILOT_ONLY (health-score route).
// They are read at call time so a missing value never breaks the build.

/** Public (browser-safe) env. Literal process.env access so Next inlines the values in client bundles. */
export function publicEnv(): PublicEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('Invalid environment: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set')
  }
  return { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey }
}
