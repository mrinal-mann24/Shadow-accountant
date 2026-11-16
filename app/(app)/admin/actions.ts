'use server'
// Admin mutations. requireUser runs outside try so its redirects are not swallowed.
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/session'
import { setUserRole } from '@/lib/auth/users'
import { isRole, type Role } from '@/lib/auth/types'
import { assignClient } from '@/lib/data'
import { toActionError, type ActionResult } from '@/components/admin/action-result'

/** Admin only. vaId null unassigns the client. */
export async function assignClientAction(clientId: string, vaId: string | null): Promise<ActionResult> {
  const user = await requireUser(['admin'])
  if (typeof clientId !== 'string' || !clientId) return { ok: false, error: 'Client not found.' }
  if (vaId !== null && (typeof vaId !== 'string' || !vaId)) return { ok: false, error: 'Accountant not found.' }
  try {
    await assignClient(user, clientId, vaId)
  } catch (e) {
    return toActionError(e)
  }
  revalidatePath('/admin', 'layout')
  return { ok: true }
}

/** Admin only. role null clears the explicit role (the accountant email rule then applies). */
export async function setUserRoleAction(userId: string, role: Role | null): Promise<ActionResult> {
  const user = await requireUser(['admin'])
  if (typeof userId !== 'string' || !userId) return { ok: false, error: 'User not found.' }
  if (role !== null && !isRole(role)) return { ok: false, error: 'Unknown role.' }
  try {
    await setUserRole(user, userId, role)
  } catch (e) {
    return toActionError(e)
  }
  revalidatePath('/admin/users')
  return { ok: true }
}
