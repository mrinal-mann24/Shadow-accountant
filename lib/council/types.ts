import { z } from 'zod'

export const DECISIONS = ['new', 'continue', 'close', 'reopen', 'no_action'] as const
export const TAGS = ['escalation', 'complaint', 'neutral', 'positive', 'suspense'] as const
export const FAULTS = ['us', 'client', 'neither'] as const
export const TONES = ['calm', 'frustrated', 'angry', 'happy', 'neutral'] as const

export type Decision = (typeof DECISIONS)[number]
export type Tag = (typeof TAGS)[number]
export type Fault = (typeof FAULTS)[number]
export type Tone = (typeof TONES)[number]

/** What each model must return. Structured output only; no tools. */
export const voteSchema = z.object({
  decision: z.enum(DECISIONS).describe('What to do with this message'),
  target_conversation_id: z
    .string()
    .nullable()
    .describe('For continue / close: an open ticket id. For reopen: a recently closed ticket id. Otherwise null.'),
  title: z.string().describe('Short ticket title, at most 80 characters. Empty when no ticket is involved.'),
  summary: z.string().describe('One to three sentence summary of the ticket so far, including this message.'),
  tag: z.enum(TAGS),
  fault: z.enum(FAULTS).describe('Whose fault the issue is, if any'),
  client_tone: z.enum(TONES),
  va_tone: z.enum(TONES).describe('Tone of our team in the recent messages'),
  reasoning: z.string().describe('One or two sentences on why'),
})

export type Vote = z.infer<typeof voteSchema>

export type FinalDecision = {
  decision: Decision
  targetConversationId: string | null
  agreed: boolean
  /** Which vote supplies title, summary, tag, fault and tones. null for no_action. */
  source: 'A' | 'B' | null
  /** Short reason for the tie-break, for logs and dry-run output. */
  rule: string
}

export type ContextMessage = {
  id: string
  at: string
  sender: string | null
  direction: 'incoming' | 'outgoing'
  body: string
}

export type ContextConversation = {
  id: string
  title: string | null
  summary: string
  last_message_at: string
}

export type CouncilContext = {
  clientName: string
  message: ContextMessage
  /** Up to 15 earlier messages in the same group, oldest first. */
  recent: ContextMessage[]
  /**
   * Messages the same person sent within a couple of minutes after the new one, oldest first. Context only: they
   * explain the new message (a Drive link, then "for bank statements"); each is decided on its own turn.
   */
  following?: ContextMessage[]
  open: ContextConversation[]
  /** Closed in the last 7 days. */
  recentlyClosed: (ContextConversation & { closed_at: string | null })[]
}
