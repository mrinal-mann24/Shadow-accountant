import { jobsWriteEnabled } from '@/lib/jobs/guard'
import { runHubspotSync } from '@/lib/hubspot/sync'
import { dealIdsFromWebhook, verifySignatureV3 } from '@/lib/hubspot/signature'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// HubSpot app webhook (deal.creation / deal.propertyChange for dealstage and amount).
// Verifies X-HubSpot-Signature-v3, then syncs only the deals in the payload (dry-run unless JOBS_WRITE_ENABLED).
export async function POST(req: Request) {
  const body = await req.text()
  const check = verifySignatureV3({
    secret: process.env.HUBSPOT_WEBHOOK_SECRET?.trim() || undefined,
    method: req.method,
    uri: req.url,
    body,
    signature: req.headers.get('x-hubspot-signature-v3'),
    timestamp: req.headers.get('x-hubspot-request-timestamp'),
    now: Date.now(),
  })
  if (!check.ok) return Response.json({ error: 'Unauthorised' }, { status: 401 })

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const dealIds = dealIdsFromWebhook(payload)
  if (dealIds === null) return Response.json({ error: 'Unexpected payload' }, { status: 400 })
  if (dealIds.length === 0) return Response.json({ ok: true, deals: 0 })

  const result = await runHubspotSync({ write: jobsWriteEnabled('hubspot-sync'), dealIds })
  return Response.json(result)
}
