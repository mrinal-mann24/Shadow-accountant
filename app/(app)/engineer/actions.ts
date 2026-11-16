'use server'
// Engineer mutations. requireUser runs outside try so its redirects are not swallowed.
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/session'
import { retryProcessing, setCouncilEnabled } from '@/lib/data'
import { toActionError, type ActionResult } from '@/components/admin/action-result'

const GENERIC_INPUT_ERROR = 'That change was not valid.'

/** Engineer only. Puts a failed message_processing_log row back to pending for the next council run. */
export async function retryProcessingAction(messageId: string): Promise<ActionResult> {
  const user = await requireUser(['engineer'])
  if (typeof messageId !== 'string' || !messageId) return { ok: false, error: 'Processing record not found.' }
  try {
    await retryProcessing(user, messageId)
  } catch (e) {
    return toActionError(e)
  }
  revalidatePath('/engineer')
  return { ok: true }
}

/** Engineer only. Turns the ticket council on or off for one client. */
export async function setCouncilEnabledAction(clientId: string, enabled: boolean): Promise<ActionResult> {
  const user = await requireUser(['engineer'])
  if (typeof clientId !== 'string' || !clientId) return { ok: false, error: 'Client not found.' }
  if (typeof enabled !== 'boolean') return { ok: false, error: GENERIC_INPUT_ERROR }
  try {
    await setCouncilEnabled(user, clientId, enabled)
  } catch (e) {
    return toActionError(e)
  }
  revalidatePath('/engineer')
  return { ok: true }
}
