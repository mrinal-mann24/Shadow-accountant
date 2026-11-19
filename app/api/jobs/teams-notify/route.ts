import { assertCronAuth, jobHttpStatus, jobsWriteEnabled, type JobResult } from '@/lib/jobs/guard'
import { CHAT_RETENTION_MS } from '@/lib/teams/chat'
import { supabaseTeamsChatStore } from '@/lib/teams/chat-store'
import { JOB, runTeamsNotifyJob } from '@/lib/teams/notify'

/** Deletes Teams chat memory and pending saves older than 7 days. Best effort: never fails the job. */
async function pruneChat(now: Date): Promise<void> {
  try {
    await supabaseTeamsChatStore.prune(new Date(now.getTime() - CHAT_RETENTION_MS).toISOString())
  } catch (e) {
    console.error('[teams-notify] chat prune failed:', e instanceof Error ? e.message : String(e))
  }
}

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
    const now = new Date()
    const result: JobResult = await runTeamsNotifyJob({ write, now })
    if (write) await pruneChat(now)
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
