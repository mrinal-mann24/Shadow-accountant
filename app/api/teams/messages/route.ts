import { after } from 'next/server'
import { askShadow } from '@/lib/agent/ask'
import { followUpAction, reassignTicket, ticketForUser, updateConversation } from '@/lib/data'
import { verifyBotRequest } from '@/lib/teams/auth'
import { handleActivity } from '@/lib/teams/bot'
import { defaultConnector } from '@/lib/teams/connector'
import { siteUrl, teamsEnv } from '@/lib/teams/env'
import { appUserByEmail } from '@/lib/teams/identity'
import { supabaseTeamsStore } from '@/lib/teams/store'
import { BotAuthError, type Activity } from '@/lib/teams/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Bot Framework messaging endpoint for the Shadow Teams bot. Every request must carry a valid Bot Framework
// JWT for our app (lib/teams/auth). The bot logic lives in lib/teams/bot; this route only wires real deps.
export async function POST(req: Request): Promise<Response> {
  const env = teamsEnv()
  const connector = env ? defaultConnector() : null
  if (!env || !connector) return Response.json({ error: 'Teams bot is not configured' }, { status: 503 })

  let activity: Activity
  try {
    activity = (await req.json()) as Activity
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!activity || typeof activity !== 'object' || typeof activity.serviceUrl !== 'string') {
    return Response.json({ error: 'Invalid activity' }, { status: 400 })
  }

  try {
    await verifyBotRequest(req.headers.get('authorization'), activity, { appId: env.appId })
  } catch (e) {
    if (e instanceof BotAuthError) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    console.error('[teams] auth check failed:', e instanceof Error ? e.message : String(e))
    return Response.json({ error: 'Auth check failed' }, { status: 500 })
  }

  try {
    const reply = await handleActivity(activity, {
      connector,
      store: supabaseTeamsStore(),
      resolveUser: appUserByEmail,
      ask: askShadow,
      data: { updateConversation, ticketForUser, reassignTicket },
      followUps: { action: followUpAction },
      siteUrl: siteUrl(),
      tenantId: env.tenantId,
      defer: (task) =>
        after(async () => {
          try {
            await task()
          } catch (e) {
            console.error('[teams] deferred task failed:', e instanceof Error ? e.message : String(e))
          }
        }),
    })
    return Response.json(reply.body ?? {}, { status: reply.status })
  } catch (e) {
    console.error('[teams] activity failed:', e instanceof Error ? e.message : String(e))
    return Response.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
