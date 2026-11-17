import 'server-only'
// "Draft reply": one structured model call over a fixed, scoped context, then code checks. Read-only:
// nothing is stored and nothing is sent. Dependencies are injectable for tests.
import { generateObject } from 'ai'
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError } from '@/lib/auth/roles'
import { formatCitationDate } from '@/lib/agent/citations'
import { getModel } from '@/lib/ai/openrouter'
import { appTimezone } from '@/lib/env'
import { getReplyContext, type ReplyContext } from '@/lib/data/reply-context'
import { checkDraft } from './guard'
import { buildReplyItems, buildReplyPrompt, REPLY_SYSTEM_PROMPT } from './prompt'
import { replyModelSchema, type DraftReplyResult, type ReplyModelOutput } from './types'

/** One attempt, no retry: the action must finish inside the pages' maxDuration (60 s). "Try again" is the retry. */
export const REPLY_TIMEOUT_MS = 45_000

export class ModelNotConfiguredError extends Error {}

export type DraftDeps = {
  getContext: (user: AppUser, ticketId: string) => Promise<ReplyContext | null>
  generate: (system: string, prompt: string) => Promise<ReplyModelOutput>
  now: () => Date
  timeZone: string
}

const defaultGenerate: DraftDeps['generate'] = async (system, prompt) => {
  let model
  try {
    model = getModel('A')
  } catch {
    throw new ModelNotConfiguredError()
  }
  const { object } = await generateObject({
    model,
    schema: replyModelSchema,
    schemaName: 'draft_reply',
    system,
    prompt,
    temperature: 0.2,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
  })
  return object
}

export const MESSAGES = {
  notFound: 'Ticket not found.',
  forbidden: 'You do not have access to this ticket.',
  notConfigured: 'The AI model is not set up yet. Ask an engineer to set the OpenRouter settings.',
  credential: 'The draft repeated sensitive details from the chat (like an OTP or password), so it was not shown. Please write this reply yourself.',
  empty: 'The AI could not write a reply for this ticket. Please write it yourself.',
  failed: 'Could not draft a reply. Please try again.',
} as const

export async function draftReply(user: AppUser, ticketId: string, deps: Partial<DraftDeps> = {}): Promise<DraftReplyResult> {
  const d: DraftDeps = {
    getContext: getReplyContext,
    generate: defaultGenerate,
    now: () => new Date(),
    timeZone: appTimezone(),
    ...deps,
  }
  try {
    const ctx = await d.getContext(user, ticketId)
    if (!ctx) return { ok: false, message: MESSAGES.notFound }
    const items = buildReplyItems(ctx, d.timeZone)
    const prompt = buildReplyPrompt({
      clientName: ctx.clientName,
      today: formatCitationDate(d.now().toISOString(), d.timeZone),
      items,
    })
    const raw = await d.generate(REPLY_SYSTEM_PROMPT, prompt)
    const checked = checkDraft(raw, items, d.timeZone)
    if (!checked.ok) return { ok: false, message: MESSAGES[checked.reason] }
    return { ok: true, draft: checked.draft }
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, message: MESSAGES.forbidden }
    if (e instanceof ModelNotConfiguredError) return { ok: false, message: MESSAGES.notConfigured }
    console.error('draftReply failed', e instanceof Error ? e.message : e)
    return { ok: false, message: MESSAGES.failed }
  }
}
