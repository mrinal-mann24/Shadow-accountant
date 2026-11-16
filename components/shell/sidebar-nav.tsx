'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Building, House, Server, Sparkles, Ticket, UserCog, UserRoundCheck, UsersRound, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isActive, type NavItem } from './nav'

const ICONS: Record<NavItem['icon'], LucideIcon> = {
  home: House,
  clients: Building,
  tickets: Ticket,
  ask: Sparkles,
  team: UsersRound,
  assignment: UserRoundCheck,
  users: UserCog,
  system: Server,
}

export function SidebarNav({ items, orientation = 'vertical' }: { items: NavItem[]; orientation?: 'vertical' | 'horizontal' }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className={cn('flex gap-1', orientation === 'vertical' ? 'flex-col' : 'overflow-x-auto')}>
      {items.map((item) => {
        const Icon = ICONS[item.icon]
        const active = isActive(pathname, item.href, items)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors',
              active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
