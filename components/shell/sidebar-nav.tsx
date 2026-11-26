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
    <nav aria-label="Main" className={cn('flex gap-0.5', orientation === 'vertical' ? 'flex-col' : 'overflow-x-auto')}>
      {items.map((item) => {
        const Icon = ICONS[item.icon]
        const active = isActive(pathname, item.href, items)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-10 shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 text-sm whitespace-nowrap transition-colors duration-200',
              active
                ? 'bg-primary-soft font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <Icon className="size-[17px]" aria-hidden />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
