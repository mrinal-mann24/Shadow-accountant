import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ROLE_LABELS, type AppUser } from '@/lib/auth/types'
import { ViewAsSelector } from './view-as-selector'

export function TopBar({
  user,
  signedInUser,
  viewAsOptions,
}: {
  user: AppUser
  signedInUser: AppUser
  /** Non-empty only for engineers who are not currently viewing as someone. */
  viewAsOptions: { vaId: string; name: string }[]
}) {
  return (
    <header className="flex h-14 items-center justify-between gap-3 border-b px-4">
      <span className="font-semibold md:hidden">Shadow Accounting</span>
      <div className="ml-auto flex items-center gap-3">
        {!user.viewingAs && <ViewAsSelector options={viewAsOptions} />}
        <div className="text-right leading-tight">
          <div className="text-sm font-medium">{signedInUser.name}</div>
          <div className="text-xs text-muted-foreground">{ROLE_LABELS[signedInUser.role]}</div>
        </div>
        <form action="/auth/sign-out" method="post">
          <Button type="submit" variant="ghost" size="sm" aria-label="Sign out">
            <LogOut aria-hidden />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </form>
      </div>
    </header>
  )
}
