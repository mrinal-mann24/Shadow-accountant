import { assertCronAuth, jobHttpStatus, jobsWriteEnabled, type JobResult } from '@/lib/jobs/guard'
import { parseEmbedLimit, runEmbedJob } from '@/lib/agent/embed'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Message embeddings batch. Dry-run (counts only) unless jobsWriteEnabled('embed'). ?limit= per run (default and max 100).
async function handle(req: Request): Promise<Response> {
  try {
    assertCronAuth(req)
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
  const limit = parseEmbedLimit(new URL(req.url).searchParams.get('limit'))
  try {
    const result: JobResult = await runEmbedJob({ write: jobsWriteEnabled('embed'), limit })
    return Response.json(result, { status: jobHttpStatus(result) })
  } catch (e) {
    const failed: JobResult = {
      job: 'embed',
      dryRun: !jobsWriteEnabled('embed'),
      processed: 0,
      written: 0,
      errors: [e instanceof Error ? e.message : String(e)],
    }
    return Response.json(failed, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
