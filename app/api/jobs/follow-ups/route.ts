import { assertCronAuth, jobHttpStatus, jobsWriteEnabled, type JobResult } from '@/lib/jobs/guard'
import { parseCouncilStartDate } from '@/lib/council/job'
import { JOB, runFollowUpsJob } from '@/lib/followups/job'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Follow-ups (promises, document chases, repeat asks). Cron at 5, 20, 35 and 50 past the hour.
// Dry-run unless jobsWriteEnabled('follow-ups'): a dry run lists the messages it would check and the cards it
// would send, with no model calls and no writes. COUNCIL_START_DATE (IST date) is the scan start too.
async function handle(req: Request): Promise<Response> {
  try {
    assertCronAuth(req)
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
  const write = jobsWriteEnabled(JOB)
  try {
    // A bad COUNCIL_START_DATE fails the run (500) instead of scanning the whole history.
    const since = parseCouncilStartDate(process.env.COUNCIL_START_DATE)
    const result: JobResult = await runFollowUpsJob({ write, now: new Date(), since })
    return Response.json(result, { status: jobHttpStatus(result) })
  } catch (e) {
    const failed: JobResult = {
      job: JOB,
      dryRun: !write,
      processed: 0,
      written: 0,
      errors: [e instanceof Error ? e.message : String(e)],
    }
    return Response.json(failed, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
