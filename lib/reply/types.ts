// Types for "Draft reply". Pure and client-safe.
import { z } from 'zod'
import type { Citation } from '@/lib/agent/citations'

/** What the model must return. Numbers in `sources` are item numbers from the prompt. */
export const replyModelSchema = z.object({
  // No .max(): a slightly long output must not fail the whole call. lib/reply/guard.ts truncates instead.
  reply: z.string().describe('The WhatsApp reply the accountant will send, ready to paste. At most about 600 characters.'),
  sources: z.array(z.number().int()).describe('Item numbers the reply relies on.'),
  confidence: z
    .enum(['high', 'low'])
    .describe('high only when every fact in the reply is in the cited items; low for holding replies or guesses.'),
  check: z.string().nullable().describe('What the accountant must confirm or fill in before sending, or null.'),
})
export type ReplyModelOutput = z.infer<typeof replyModelSchema>

export type DraftReply = {
  reply: string
  sources: Citation[]
  confidence: 'high' | 'low'
  check: string | null
  /** Plain warnings from the code checks, shown above the draft. */
  warnings: string[]
}

export type DraftReplyResult = { ok: true; draft: DraftReply } | { ok: false; message: string }
