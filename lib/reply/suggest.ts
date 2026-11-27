import 'server-only'
// "Suggested reply" (AI reply drafts): for an open ticket of a pilot client where the client is waiting on us, the AI
// writes the reply our team would send, in that client's style (its style guide, the v3 drafting rules and the latest
// accountant corrections). Nothing is sent: the accountant edits and copies it. Each suggestion is saved
// (reply_suggestions) so edits can teach the next drafts. Dependencies are injectable for tests.
import { generateText } from 'ai'
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError } from '@/lib/auth/roles'
import { getModel, getModelId } from '@/lib/ai/openrouter'
import { getReplyContext, type ReplyContext } from '@/lib/data/reply-context'
import {
  findRecentSuggestion,
  getReplyStyle,
  listReplyCorrections,
  saveReplySuggestion,
  storableText,
} from '@/lib/data/reply-suggestions'
import type { MessageItem } from '@/lib/data/types'
import { clean, istTime, line, type Correction } from './chat-text'
import {
  buildSuggestPrompt,
  DRAFT_PROMPTS,
  SUGGEST_CORRECTIONS,
  SUGGEST_MAX_OUTPUT_TOKENS,
  SUGGEST_PROMPT_VERSION,
  SUGGEST_RECENT_MESSAGES,
} from './suggest-prompt'
import type { StoredGuide } from './style-guide'

/** One attempt plus one retry when the model returns nothing, inside the page's 60 s maxDuration. */
export const SUGGEST_TIMEOUT_MS = 25_000

export type SuggestResult =
  | {
      ok: true
      /** What the AI wrote. */
      draft: string
      /** What to show: the AI draft, or the accountant's own edit when they already edited this suggestion. */
      text: string
      /** null when it could not be saved (viewing as someone, or before the table exists): edits are then not learned. */
      suggestionId: string | null
      /** true when this is the earlier suggestion for the same client message (no new model call). */
      reused: boolean
      guideVersion: number
      guideBuiltAt: string
    }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'not_pilot' | 'closed' | 'no_question' | 'empty' | 'not_configured' | 'failed'; message: string }

export const SUGGEST_MESSAGES = {
  not_found: 'Ticket not found.',
  forbidden: 'You do not have access to this ticket.',
  not_pilot: 'Suggested replies are not set up for this client yet.',
  closed: 'This ticket is closed.',
  no_question: 'Our team replied last, so there is nothing to answer right now.',
  empty: 'The AI could not write a reply for this ticket. Please write it yourself.',
  not_configured: 'The AI model is not set up yet. Ask an engineer to set the OpenRouter settings.',
  failed: 'Could not write a suggested reply. Please try again.',
} as const

export type SuggestDeps = {
  getContext: (user: AppUser, ticketId: string) => Promise<ReplyContext | null>
  getStyle: (user: AppUser, clientId: string) => Promise<StoredGuide | null>
  getCorrections: (user: AppUser, clientId: string, limit: number) => Promise<Correction[]>
  generate: (system: string, prompt: string) => Promise<string>
  save: typeof saveReplySuggestion
  findRecent: typeof findRecentSuggestion
  modelId: () => string
}

class ModelNotConfiguredError extends Error {}

const defaultGenerate: SuggestDeps['generate'] = async (system, prompt) => {
  let model
  try {
    model = getModel('A')
  } catch {
    throw new ModelNotConfiguredError()
  }
  // 600 output tokens left drafts empty (the model's reasoning used them up): allow more and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await generateText({
      model,
      system,
      prompt,
      temperature: 0.2,
      maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
    })
    const text = res.text.trim()
    if (text) return text
  }
  return ''
}

/** The client's latest unanswered messages: the trailing client messages after our team's last one, oldest first. */
export function pendingQuestion(messages: MessageItem[]): MessageItem[] {
  const out: MessageItem[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction !== 'incoming') break
    out.unshift(messages[i])
  }
  return out.filter((m) => (m.body ?? '').trim())
}

/** Up to n messages before `before` (ISO), oldest first, from the group's recent messages. */
export function messagesBefore(messages: MessageItem[], before: string, n: number): MessageItem[] {
  const at = Date.parse(before)
  return messages.filter((m) => Date.parse(m.at) < at).slice(-n)
}

export async function suggestReply(
  user: AppUser,
  ticketId: string,
  opts: { force?: boolean } = {},
  deps: Partial<SuggestDeps> = {},
): Promise<SuggestResult> {
  const d: SuggestDeps = {
    getContext: getReplyContext,
    getStyle: getReplyStyle,
    getCorrections: listReplyCorrections,
    generate: defaultGenerate,
    save: saveReplySuggestion,
    findRecent: findRecentSuggestion,
    modelId: () => getModelId('A'),
    ...deps,
  }
  const fail = (reason: Exclude<SuggestResult, { ok: true }>['reason']): SuggestResult => ({
    ok: false,
    reason,
    message: SUGGEST_MESSAGES[reason],
  })
  try {
    const ctx = await d.getContext(user, ticketId)
    if (!ctx) return fail('not_found')
    const t = ctx.ticket
    if (t.status !== 'open') return fail('closed')
    const guide = await d.getStyle(user, t.clientId)
    if (!guide) return fail('not_pilot')
    // The ticket's own thread first; the group's latest messages when the ticket has none linked yet.
    const question = pendingQuestion(ctx.ticketMessages.length ? ctx.ticketMessages : ctx.recentMessages)
    if (!question.length) return fail('no_question')

    // Same client message as last time: show that suggestion again (no model call), unless Regenerate was asked.
    const lastAsk = question[question.length - 1].at
    if (!opts.force) {
      const saved = await d.findRecent(user, { conversationId: t.id, clientId: t.clientId, since: lastAsk })
      if (saved) {
        return {
          ok: true,
          draft: saved.draft,
          text: saved.finalText ?? saved.draft,
          suggestionId: user.viewingAs ? null : saved.id,
          reused: true,
          guideVersion: saved.guideVersion ?? guide.version,
          guideBuiltAt: guide.builtAt,
        }
      }
    }

    const recent =messagesBefore(ctx.recentMessages, question[0].at, SUGGEST_RECENT_MESSAGES)
    const corrections = await d.getCorrections(user, t.clientId, SUGGEST_CORRECTIONS)
    const prompt = buildSuggestPrompt({
      clientName: ctx.clientName ?? t.clientName ?? 'Client',
      guide: guide.guide,
      recentLines: recent.map(line),
      question: question.map(clean).join('\n'),
      askedAtIst: istTime(question[0].at),
      corrections,
    })
    const text = await d.generate(DRAFT_PROMPTS[SUGGEST_PROMPT_VERSION], prompt)
    const draft = text ? storableText(text) : ''
    if (!draft) return fail('empty')

    let suggestionId: string | null = null
    try {
      suggestionId = await d.save(user, {
        conversationId: t.id,
        clientId: t.clientId,
        model: d.modelId(),
        guideVersion: guide.version,
        promptVersion: SUGGEST_PROMPT_VERSION,
        draft,
      })
    } catch (e) {
      // The reply is still useful; only the learning record is lost.
      console.error('suggestReply: could not save the suggestion', e instanceof Error ? e.message : e)
    }
    return { ok: true, draft, text: draft, suggestionId, reused: false, guideVersion: guide.version, guideBuiltAt: guide.builtAt }
  } catch (e) {
    if (e instanceof ForbiddenError) return fail('forbidden')
    if (e instanceof ModelNotConfiguredError) return fail('not_configured')
    console.error('suggestReply failed', e instanceof Error ? e.message : e)
    return fail('failed')
  }
}
