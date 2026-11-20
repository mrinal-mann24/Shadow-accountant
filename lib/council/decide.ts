// Pure council logic: validate each model's vote against the context, then combine two votes.
import type { CouncilContext, FinalDecision, Vote } from './types'

/**
 * Makes a vote safe to act on. The target id must be one the model was actually shown:
 * - continue / close: an open conversation id
 * - reopen: a conversation closed in the last 7 days
 * - new / no_action: target forced to null
 * Anything else (made-up id, missing id, wrong status) becomes no_action.
 */
export function validateVote(vote: Vote, ctx: Pick<CouncilContext, 'open' | 'recentlyClosed'>): Vote {
  const openIds = new Set(ctx.open.map((c) => c.id))
  const closedIds = new Set(ctx.recentlyClosed.map((c) => c.id))
  const target = vote.target_conversation_id?.trim() || null

  switch (vote.decision) {
    case 'new':
    case 'no_action':
      return { ...vote, target_conversation_id: null }
    case 'continue':
    case 'close':
      if (target && openIds.has(target)) return { ...vote, target_conversation_id: target }
      break
    case 'reopen':
      if (target && closedIds.has(target)) return { ...vote, target_conversation_id: target }
      break
  }
  return {
    ...vote,
    decision: 'no_action',
    target_conversation_id: null,
    reasoning: `Invalid target for ${vote.decision} (${target ?? 'none'}). ${vote.reasoning}`.trim(),
  }
}

/**
 * Combines two validated votes. Tie-break rules, in order:
 * 1. Same decision and same target: that decision, agreed. Metadata from A.
 * 2. One says new, the other says continue: continue on the continue voter's target (not agreed).
 *    Better to add to an open ticket than to open a duplicate.
 * 3. One says close, the other continue, on the same ticket: continue on it (not agreed). Both agree the message
 *    belongs to that ticket, so it is added (a team reply then counts as the reply); closing still needs both.
 * 4. close and reopen happen only when both agree on the same target (rule 1).
 * 5. Anything else: no_action, not agreed.
 */
export function combineVotes(a: Vote, b: Vote): FinalDecision {
  if (a.decision === b.decision && (a.target_conversation_id ?? null) === (b.target_conversation_id ?? null)) {
    return {
      decision: a.decision,
      targetConversationId: a.target_conversation_id ?? null,
      agreed: true,
      source: a.decision === 'no_action' ? null : 'A',
      rule: 'both agree',
    }
  }
  if (a.decision === 'continue' && b.decision === 'new') {
    return { decision: 'continue', targetConversationId: a.target_conversation_id, agreed: false, source: 'A', rule: 'new vs continue: continue wins' }
  }
  if (a.decision === 'new' && b.decision === 'continue') {
    return { decision: 'continue', targetConversationId: b.target_conversation_id, agreed: false, source: 'B', rule: 'new vs continue: continue wins' }
  }
  const sameTarget = !!a.target_conversation_id && a.target_conversation_id === b.target_conversation_id
  if (sameTarget && a.decision === 'continue' && b.decision === 'close') {
    return { decision: 'continue', targetConversationId: a.target_conversation_id, agreed: false, source: 'A', rule: 'close vs continue on the same ticket: continue' }
  }
  if (sameTarget && a.decision === 'close' && b.decision === 'continue') {
    return { decision: 'continue', targetConversationId: b.target_conversation_id, agreed: false, source: 'B', rule: 'close vs continue on the same ticket: continue' }
  }
  return {
    decision: 'no_action',
    targetConversationId: null,
    agreed: false,
    source: null,
    rule: `disagree (${a.decision} vs ${b.decision}): no action`,
  }
}
