// Shared guard for scheduled job routes (app/api/jobs/*).
// Reads process.env at call time (not the cached serverEnv) so it works before Supabase env is set
// and so tests can flip values.

export type JobResult = {
  job: string
  dryRun: boolean
  processed: number
  written: number
  errors: string[]
  /** A step the whole run depends on failed (missing token, pull or upsert error). The route returns 500. */
  fatal?: boolean
  details?: unknown
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Throws a 401 Response unless the request carries `Authorization: Bearer <CRON_SECRET>`.
 * Fails closed: if CRON_SECRET is not set, every request is rejected.
 * Usage in a route: `try { assertCronAuth(req) } catch (e) { if (e instanceof Response) return e; throw e }`
 */
export function assertCronAuth(req: Request): void {
  const secret = process.env.CRON_SECRET?.trim()
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match?.[1]?.trim() ?? ''
  if (!secret || !token || !safeEqual(token, secret)) {
    throw new Response(JSON.stringify({ error: 'Unauthorised' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
}

/**
 * Fails closed. A job may write only when JOBS_WRITE_ENABLED is exactly "true" (case-insensitive) AND the
 * job is named in JOBS_WRITE_ONLY (comma list, e.g. "health-score,council"), so each job is approved on its
 * own. A blank JOBS_WRITE_ONLY means no job writes, and a call without a job name always returns false.
 * JOBS_WRITE_ONLY can never turn writes on by itself.
 */
export function jobsWriteEnabled(job?: string): boolean {
  if (process.env.JOBS_WRITE_ENABLED?.trim().toLowerCase() !== 'true') return false
  const only = (process.env.JOBS_WRITE_ONLY ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return job !== undefined && only.includes(job.trim().toLowerCase())
}

/**
 * HTTP status for a job route, so cron monitoring sees a run that did not work. 500 when a step the whole
 * run depends on failed (`fatal`), when a write run had errors and wrote nothing, or when every processed
 * item failed. 200 otherwise: partial per-item errors stay 200 and are listed in `errors`.
 */
export function jobHttpStatus(result: JobResult): number {
  const errors = result.errors.length
  if (errors === 0) return 200
  if (result.fatal) return 500
  if (!result.dryRun && result.written === 0) return 500
  if (errors >= result.processed) return 500
  return 200
}
