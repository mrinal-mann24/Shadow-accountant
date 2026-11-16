import { assertCronAuth, jobHttpStatus, jobsWriteEnabled, type JobResult } from '@/lib/jobs/guard'
import { runHealthScoreJob } from '@/lib/scoring/job'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Daily health score. Dry-run unless jobsWriteEnabled('health-score'). 500 when the run failed (jobHttpStatus). Optional ?clientIds=a,b to score only those clients.
async function handle(req: Request): Promise<Response> {
  try {
    assertCronAuth(req)
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
  const ids = new URL(req.url).searchParams
    .get('clientIds')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    const result: JobResult = await runHealthScoreJob({
      write: jobsWriteEnabled('health-score'),
      now: new Date(),
      clientIds: ids && ids.length > 0 ? ids : undefined,
    })
    return Response.json(result, { status: jobHttpStatus(result) })
  } catch (e) {
    const failed: JobResult = {
      job: 'health-score',
      dryRun: !jobsWriteEnabled('health-score'),
      processed: 0,
      written: 0,
      errors: [e instanceof Error ? e.message : String(e)],
    }
    return Response.json(failed, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
