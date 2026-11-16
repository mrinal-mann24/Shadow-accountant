import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getAuthState } from '@/lib/auth/session'

export const metadata: Metadata = { title: 'Access not set up' }
export const dynamic = 'force-dynamic'

export default async function NoAccessPage() {
  const state = await getAuthState()
  if (state.status === 'anonymous') redirect('/login')
  if (state.status === 'ok') redirect('/home')

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Your account is not set up yet</CardTitle>
          <CardDescription>
            {state.email ? (
              <>
                You are signed in as <span className="font-medium text-foreground">{state.email}</span>, but this
                account has no access to Shadow Accounting.
              </>
            ) : (
              'This account has no email address, so it cannot be matched to an accountant.'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Please ask an Admin to add you. Once they have, sign in again.
          </p>
          <form action="/auth/sign-out" method="post">
            <Button type="submit" variant="outline" className="w-full">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
