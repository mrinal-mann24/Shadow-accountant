// Whose turn an open ticket is. Pure and client-safe (types only), shared by the Tickets screen and the Team numbers.
import type { ConversationItem } from './types'

export type WaitingSide = 'us' | 'client'

/**
 * 'client' when our team raised the ticket (asked the client for something) and our message is still the last one:
 * the client has not answered, so it does not count against the team. Everything else is 'us'. Known limit: a ticket
 * the client raised where we then asked them a question stays 'us' (the stored data cannot tell a question from an
 * answer).
 */
export function waitingSide(t: Pick<ConversationItem, 'openedBy' | 'lastMessageDirection'>): WaitingSide {
  return t.openedBy === 'outgoing' && t.lastMessageDirection === 'outgoing' ? 'client' : 'us'
}
