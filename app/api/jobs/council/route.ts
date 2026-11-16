import { assertCronAuth, jobHttpStatus, jobsWriteEnabled, type JobResult } from '@/lib/jobs/guard'
import { parseCouncilLimit, runCouncilJob } from '@/lib/council/job'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Ticket council batch. Dry-run unless jobsWriteEnabled('council').
// ?limit= messages per run (default 25, max 100). Optional ?clientIds=a,b to run only those clients.
// A dry run only lists the messages it would vote on, with no model calls, so the 15 minute cron does not
// spend OpenRouter calls while writes are off. Add ?vote=1 to a manual dry run to call both models.
async function handle(req: Request): Promise<Response> {
  try {
    assertCronAuth(req)
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
  const params = new URL(req.url).searchParams
  const ids = params
    .get('clientIds')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    const result: JobResult = await runCouncilJob({
      write: jobsWriteEnabled('council'),
      limit: parseCouncilLimit(params.get('limit')),
      vote: params.get('vote') === '1',
      clientIds: ids && ids.length > 0 ? ids : undefined,
    })
    return Response.json(result, { status: jobHttpStatus(result) })
  } catch (e) {
    const failed: JobResult = {
      job: 'council',
      dryRun: !jobsWriteEnabled('council'),
      processed: 0,
      written: 0,
      errors: [e instanceof Error ? e.message : String(e)],
    }
    return Response.json(failed, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
