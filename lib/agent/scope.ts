// Chat scope and request parsing. Pure (no server-only imports), so it is unit tested.
import { z } from 'zod'

export type ScopedClient = { id: string; name: string }

/**
 * What one chat request may read.
 * - clients: every client the user may see (from lib/data listClients, already scoped by AppUser).
 * - fixedClientId: set when the user picked a client; every tool is then locked to it.
 * - allClients: true when the user sees every client and none is picked (search needs no client filter).
 */
export type ChatScope = {
  clients: ScopedClient[]
  fixedClientId: string | null
  allClients: boolean
}

export type ScopeResult = { ok: true; scope: ChatScope } | { ok: false; error: string }

export const OUT_OF_SCOPE = 'This client is not in your list of clients.'

/** Builds the scope for a request. A requested client must be in the user's own list. */
export function resolveChatScope(input: {
  clients: ScopedClient[]
  canSeeAll: boolean
  requestedClientId?: string | null
}): ScopeResult {
  const requested = input.requestedClientId?.trim() || null
  if (requested && !input.clients.some((c) => c.id === requested)) return { ok: false, error: OUT_OF_SCOPE }
  return {
    ok: true,
    scope: { clients: input.clients, fixedClientId: requested, allClients: input.canSeeAll && !requested },
  }
}

/**
 * The client a tool call may use. With a fixed client, a missing id means that client and any other id is refused.
 * Without one, the id must be in the user's list.
 */
export function toolClientId(scope: ChatScope, asked: string | null | undefined): { ok: true; clientId: string } | { ok: false; error: string } {
  const id = asked?.trim() || null
  if (scope.fixedClientId) {
    if (id && id !== scope.fixedClientId) return { ok: false, error: OUT_OF_SCOPE }
    return { ok: true, clientId: scope.fixedClientId }
  }
  if (!id) return { ok: false, error: 'Say which client: pass clientId from the list of clients.' }
  if (!scope.clients.some((c) => c.id === id)) return { ok: false, error: OUT_OF_SCOPE }
  return { ok: true, clientId: id }
}

/** Client ids a message search may cover: null means every client (user sees all, none picked). */
export function searchClientIds(scope: ChatScope, asked?: string | null): { ok: true; clientIds: string[] | null } | { ok: false; error: string } {
  const id = asked?.trim() || null
  if (scope.fixedClientId || id) {
    const r = toolClientId(scope, id)
    return r.ok ? { ok: true, clientIds: [r.clientId] } : r
  }
  if (scope.allClients) return { ok: true, clientIds: null }
  return { ok: true, clientIds: scope.clients.map((c) => c.id) }
}

export const MAX_HISTORY = 12
export const MAX_TEXT = 4000

const chatRequestSchema = z.object({
  clientId: z.string().trim().max(100).nullish(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20000) }))
    .min(1)
    .max(100),
})

export type ChatTurn = { role: 'user' | 'assistant'; text: string }
export type ChatRequest = { clientId: string | null; messages: ChatTurn[] }

/**
 * Validates the chat request body: { clientId?, messages: [{ role, text }] }. Keeps the last MAX_HISTORY turns,
 * cuts each to MAX_TEXT characters, drops empty turns, and requires the last turn to be the user's question.
 */
export function parseChatRequest(body: unknown): { ok: true; value: ChatRequest } | { ok: false; error: string } {
  const r = chatRequestSchema.safeParse(body)
  if (!r.success) return { ok: false, error: 'Invalid chat request.' }
  const turns = r.data.messages
    .map((m) => ({ role: m.role, text: m.text.trim().slice(0, MAX_TEXT) }))
    .filter((m) => m.text.length > 0)
    .slice(-MAX_HISTORY)
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'user') return { ok: false, error: 'Ask a question first.' }
  return { ok: true, value: { clientId: r.data.clientId || null, messages: turns } }
}
