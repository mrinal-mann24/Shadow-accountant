import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getAuthState } from '@/lib/auth/session'
import { devLoginEmail, safeNextPath } from '@/lib/auth/roles'
import { devLogin, signInWithMicrosoft } from './actions'

export const metadata: Metadata = { title: 'Sign in' }
export const dynamic = 'force-dynamic'

const ERRORS: Record<string, string> = {
  start: 'We could not start Microsoft sign in. Please try again.',
  provider: 'Microsoft sign in was cancelled or failed. Please try again.',
  missing_code: 'The sign in link was incomplete. Please try again.',
  exchange: 'Your sign in could not be completed. Please try again.',
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next: rawNext, error } = await searchParams
  const next = safeNextPath(rawNext)

  const state = await getAuthState()
  if (state.status === 'ok') redirect(next)
  if (state.status === 'no_access') redirect('/no-access')

  const devEmail = devLoginEmail(process.env)

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Shadow Accounting</CardTitle>
          <CardDescription>Sign in with your AI Accountant Microsoft account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {ERRORS[error] ?? 'Something went wrong. Please try again.'}
            </p>
          )}
          <form action={signInWithMicrosoft}>
            <input type="hidden" name="next" value={next} />
            <Button type="submit" className="w-full">
              Sign in with Microsoft
            </Button>
          </form>

          {/* DEV LOGIN: rendered only when NODE_ENV !== 'production' and DEV_LOGIN_EMAIL is set. */}
          {devEmail && (
            <form action={devLogin} className="rounded-md border border-dashed border-warning p-3">
              <input type="hidden" name="next" value={next} />
              <p className="mb-2 text-xs text-muted-foreground">
                Development only. Not available in production.
              </p>
              <Button type="submit" variant="outline" size="sm" className="w-full">
                Dev login as {devEmail}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
