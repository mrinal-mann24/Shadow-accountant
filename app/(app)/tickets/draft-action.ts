'use server'
// "Draft reply" for one ticket. Read-only: works for every signed-in role (including "viewing as"), scoped by lib/data.
import { requireUser } from '@/lib/auth/session'
import { draftReply } from '@/lib/reply/draft'
import type { DraftReplyResult } from '@/lib/reply/types'

export async function draftReplyAction(ticketId: string): Promise<DraftReplyResult> {
  const user = await requireUser()
  const id = typeof ticketId === 'string' ? ticketId.trim() : ''
  if (!id || id.length > 100) return { ok: false, message: 'Ticket not found.' }
  return draftReply(user, id)
}
