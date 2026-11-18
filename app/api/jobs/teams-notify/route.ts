import { assertCronAuth, jobHttpStatus, jobsWriteEnabled, type JobResult } from '@/lib/jobs/guard'
import { JOB, runTeamsNotifyJob } from '@/lib/teams/notify'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Teams notifications (new tickets, reminders, escalations, new client files). Cron every 5 minutes.
// Dry-run unless jobsWriteEnabled('teams-notify'): a dry run lists the cards it would send and sends nothing.
async function handle(req: Request): Promise<Response> {
  try {
    assertCronAuth(req)
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
  const write = jobsWriteEnabled(JOB)
  try {
    const result: JobResult = await runTeamsNotifyJob({ write, now: new Date() })
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
