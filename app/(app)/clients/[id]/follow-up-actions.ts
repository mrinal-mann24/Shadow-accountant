'use server'
// Follow-up buttons on the client page (Done / Not needed / Extend 1 day, Answered / Not a repeat).
// All writes go through lib/data followUpAction (scoped by AppUser, read only in view as).
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { assertNotViewingAs, ForbiddenError, requireUser, ViewAsReadOnlyError } from '@/lib/auth/session'
import { followUpAction } from '@/lib/data'
import type { FollowUpActionState } from '@/components/accountant/follow-ups'

const Input = z.object({
  id: z.uuid(),
  action: z.enum(['done', 'cancel', 'extend']),
})

// Messages from followUpAction that are safe and useful to show as they are. Anything else (database errors,
// "followUpAction: ..." wrappers) is logged and replaced by a generic line, never shown raw.
const KNOWN_ERRORS = new Set([
  'Follow-up not found.',
  'This follow-up is already closed.',
  'Only promises and document requests can be extended.',
])

function friendlyError(e: unknown): string | null {
  // ViewAsReadOnlyError extends ForbiddenError, so it is checked first.
  if (e instanceof ViewAsReadOnlyError) return 'Read only while viewing as another accountant.'
  // Out of scope client, or a role that cannot act (engineer).
  if (e instanceof ForbiddenError) return 'You cannot change this follow-up.'
  if (e instanceof Error && e.message === 'Unknown follow-up action.') return 'That change is not valid.'
  if (e instanceof Error && KNOWN_ERRORS.has(e.message)) return e.message
  return null
}

export async function followUpFormAction(_prev: FollowUpActionState, formData: FormData): Promise<FollowUpActionState> {
  const user = await requireUser()
  const parsed = Input.safeParse({ id: formData.get('id'), action: formData.get('action') })
  if (!parsed.success) return { ok: false, error: 'That change is not valid.' }

  try {
    assertNotViewingAs(user)
    await followUpAction(user, parsed.data.id, parsed.data.action)
  } catch (e) {
    const known = friendlyError(e)
    if (known) return { ok: false, error: known }
    console.error('followUpFormAction failed', e)
    return { ok: false, error: 'Could not update the follow-up. Please try again.' }
  }

  revalidatePath('/clients/[id]', 'page')
  revalidatePath('/home')
  return { ok: true, error: null }
}
