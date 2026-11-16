import { assertCronAuth, jobHttpStatus, jobsWriteEnabled, type JobResult } from '@/lib/jobs/guard'
import { runHubspotSync } from '@/lib/hubspot/sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// HubSpot two-way sync. Dry-run unless jobsWriteEnabled('hubspot-sync'). 500 when the run failed (jobHttpStatus).
export async function GET(req: Request) {
  try {
    assertCronAuth(req)
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
  try {
    const result: JobResult = await runHubspotSync({ write: jobsWriteEnabled('hubspot-sync') })
    return Response.json(result, { status: jobHttpStatus(result) })
  } catch (e) {
    const failed: JobResult = {
      job: 'hubspot-sync',
      dryRun: !jobsWriteEnabled('hubspot-sync'),
      processed: 0,
      written: 0,
      errors: [e instanceof Error ? e.message : String(e)],
    }
    return Response.json(failed, { status: 500 })
  }
}
