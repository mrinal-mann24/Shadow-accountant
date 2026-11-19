import { createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type LanguageModel, type ModelMessage } from 'ai'
import { requireUser } from '@/lib/auth/session'
import { appTimezone } from '@/lib/env'
import { listClients, scopeOf } from '@/lib/data'
import { getModel } from '@/lib/ai/openrouter'
import { createCitationRegistry, formatCitationDate, nextCitationStart } from '@/lib/agent/citations'
import { buildSystemPrompt } from '@/lib/agent/prompt'
import { parseChatRequest, resolveChatScope, toScopedClient } from '@/lib/agent/scope'
import { createChatTools } from '@/lib/agent/tools'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Tool rounds per question (each round can call several tools), then the model must answer. */
export const MAX_STEPS = 6

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

// Client-scoped, read-only chat with citations. Body: { clientId?: string, messages: [{ role, text }] }.
// Streams a UI message stream (AI SDK). Tool outputs carry the citations the answer refers to as [n].
export async function POST(req: Request): Promise<Response> {
  const user = await requireUser()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonError(400, 'Invalid chat request.')
  }
  const parsed = parseChatRequest(body)
  if (!parsed.ok) return jsonError(400, parsed.error)
  const { clientId, messages } = parsed.value

  const clients = (await listClients(user, { status: 'all' })).map(toScopedClient)
  const resolved = resolveChatScope({ clients, canSeeAll: scopeOf(user).all, requestedClientId: clientId })
  if (!resolved.ok) return jsonError(403, resolved.error)
  const scope = resolved.scope

  let model: LanguageModel
  try {
    model = getModel('A')
  } catch {
    return jsonError(503, 'The AI model is not set up yet. Ask an engineer to set the OpenRouter settings.')
  }

  const timeZone = appTimezone()
  const registry = createCitationRegistry(
    nextCitationStart(messages.filter((m) => m.role === 'assistant').map((m) => m.text)),
  )
  const fixedClient = scope.fixedClientId ? (clients.find((c) => c.id === scope.fixedClientId) ?? null) : null
  const instructions = buildSystemPrompt({
    userName: user.name,
    today: formatCitationDate(new Date().toISOString(), timeZone),
    clients: scope.clients,
    fixedClient,
  })
  // History is text only: earlier tool results are not replayed, so the model searches again for new questions.
  const history: ModelMessage[] = messages.map((m) => ({ role: m.role, content: m.text }))

  const result = streamText({
    model,
    instructions,
    messages: history,
    tools: createChatTools({ user, scope, registry, timeZone }),
    stopWhen: isStepCount(MAX_STEPS),
    temperature: 0.1,
    maxOutputTokens: 1500,
    abortSignal: req.signal,
  })

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      onError: () => 'Something went wrong while answering. Please try again.',
    }),
  })
}
