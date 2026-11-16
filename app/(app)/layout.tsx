import { redirect } from 'next/navigation'
import { AppShell } from '@/components/shell/app-shell'
import { getAuthState, loadVas } from '@/lib/auth/session'

// Every page under (app) needs a signed-in, set-up user. Pages still call requireUser(roles) for role checks.
export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const state = await getAuthState()
  if (state.status === 'anonymous') redirect('/login')
  if (state.status === 'no_access') redirect('/no-access')

  const { user, signedInUser } = state
  const viewAsOptions =
    signedInUser.role === 'engineer' && !user.viewingAs
      ? (await loadVas()).map((v) => ({ vaId: v.va_id, name: v.va_name }))
      : []

  return (
    <AppShell user={user} signedInUser={signedInUser} viewAsOptions={viewAsOptions}>
      {children}
    </AppShell>
  )
}
