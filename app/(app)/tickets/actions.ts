'use server'
// Ticket mutations for the Senior Accountant screens. All writes go through lib/data (scoped by AppUser).
import { revalidatePath } from 'next/cache'
import { ZodError } from 'zod'
import { assertNotViewingAs, ForbiddenError, requireUser } from '@/lib/auth/session'
import { updateConversation } from '@/lib/data'
import type { ConversationPatch } from '@/lib/data/types'
import { parseTicketIntent, type TicketActionState } from '@/components/accountant/ticket-intent'

export async function ticketAction(_prev: TicketActionState, formData: FormData): Promise<TicketActionState> {
  const user = await requireUser()
  const parsed = parseTicketIntent(formData)
  if (!parsed.ok) return { ok: false, message: parsed.message }

  let patch: ConversationPatch
  if (parsed.intent === 'tag') patch = { tag: parsed.tag }
  else patch = { status: parsed.intent === 'close' ? 'closed' : 'open' }

  try {
    assertNotViewingAs(user)
    await updateConversation(user, parsed.id, patch)
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, message: e.message }
    if (e instanceof ZodError) return { ok: false, message: 'That change is not valid.' }
    if (e instanceof Error && e.message === 'Ticket not found.') return { ok: false, message: e.message }
    console.error('ticketAction failed', e)
    return { ok: false, message: 'Could not update the ticket. Please try again.' }
  }

  revalidatePath('/home')
  revalidatePath('/tickets')
  revalidatePath('/clients/[id]', 'page')
  const message =
    parsed.intent === 'close' ? 'Ticket closed.' : parsed.intent === 'reopen' ? 'Ticket reopened.' : 'Tag updated.'
  return { ok: true, message }
}
