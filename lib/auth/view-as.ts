'use server'
// Engineer "view as" server actions. Read-only mode: mutations call assertNotViewingAs(user).
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { AUTH_COOKIE_OPTIONS, VIEW_AS_COOKIE } from './cookies'
import { ForbiddenError } from './roles'
import { getAuthState, loadVas } from './session'

async function requireSignedInEngineer() {
  const state = await getAuthState()
  if (state.status !== 'ok' || state.signedInUser.role !== 'engineer') {
    throw new ForbiddenError('Only engineers can use view as.')
  }
  return state.signedInUser
}

/** Accountants an engineer can view as. Engineer only. */
export async function listViewAsOptions(): Promise<{ vaId: string; name: string }[]> {
  await requireSignedInEngineer()
  return (await loadVas()).map((v) => ({ vaId: v.va_id, name: v.va_name }))
}

/** Start viewing the app as accountant `vaId` (read-only). Engineer only. Redirects to /home. */
export async function setViewAs(vaId: string): Promise<void> {
  await requireSignedInEngineer()
  if (typeof vaId !== 'string' || !(await loadVas()).some((v) => v.va_id === vaId)) {
    throw new ForbiddenError('That accountant was not found.')
  }
  ;(await cookies()).set(VIEW_AS_COOKIE, vaId, AUTH_COOKIE_OPTIONS)
  redirect('/home')
}

/** Stop viewing as. Engineer only. Redirects to /home. */
export async function clearViewAs(): Promise<void> {
  await requireSignedInEngineer()
  ;(await cookies()).delete(VIEW_AS_COOKIE)
  redirect('/home')
}
