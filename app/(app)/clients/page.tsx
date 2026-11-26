import type { Metadata } from 'next'
import Link from 'next/link'
import { CircleAlert, Search } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/accountant/ui'
import { ClientsTable } from '@/components/clients/clients-table'
import { SeniorFilter } from '@/components/clients/senior-filter'
import { toRowView } from '@/components/clients/view'
import { requireUser } from '@/lib/auth/session'
import { canSeeAllClients } from '@/lib/auth/roles'
import { listClients, listVas } from '@/lib/data'
import { groupClients, parseClientTab, subgroupCount, type ClientTab } from '@/lib/data/client-groups'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Clients' }
export const dynamic = 'force-dynamic'

const TAB_LABELS: Record<ClientTab, string> = { clients: 'Clients', other: 'Other groups', past: 'Past clients' }

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; tab?: string | string[]; status?: string | string[]; va?: string | string[] }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const q = first(params.q)?.trim().slice(0, 100) ?? ''
  // Older links used ?status=inactive for the past list.
  const tab = first(params.tab) ? parseClientTab(first(params.tab)) : first(params.status) === 'inactive' ? 'past' : 'clients'
  const showSenior = canSeeAllClients(user)
  const va = showSenior ? (first(params.va)?.trim().slice(0, 64) ?? '') : ''

  const [clients, vas] = await Promise.all([
    listClients(user, { status: 'all', ...(va ? { vaId: va } : {}) }),
    showSenior ? listVas(user) : Promise.resolve([]),
  ])
  const grouped = groupClients(clients, { search: q })
  const now = new Date()
  const rows = grouped[tab].map((g) => toRowView(g, now))
  const subs = subgroupCount(grouped[tab])

  const href = (t: ClientTab) => {
    const sp = new URLSearchParams()
    if (t !== 'clients') sp.set('tab', t)
    if (q) sp.set('q', q)
    if (va) sp.set('va', va)
    const s = sp.toString()
    return s ? `/clients?${s}` : '/clients'
  }
  const clearHref = (() => {
    const sp = new URLSearchParams()
    if (tab !== 'clients') sp.set('tab', tab)
    if (va) sp.set('va', va)
    const s = sp.toString()
    return s ? `/clients?${s}` : '/clients'
  })()

  const noun = tab === 'other' ? ['group', 'groups'] : tab === 'past' ? ['past client', 'past clients'] : ['client', 'clients']
  const footer =
    `${rows.length} ${rows.length === 1 ? noun[0] : noun[1]}` +
    (subs > 0 ? ` · ${subs} ${subs === 1 ? 'subgroup' : 'subgroups'} folded inside them` : '') +
    (q ? ` · matching "${q}"` : '')

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader
        title="Clients"
        description="A client is a paid VA deal in HubSpot. Its WhatsApp subgroups live inside it."
        action={
          <form role="search" action="/clients" className="flex flex-wrap items-center gap-2.5">
            {tab !== 'clients' && <input type="hidden" name="tab" value={tab} />}
            <label className="flex h-10 w-[260px] max-w-full items-center gap-2 rounded-xl border bg-card px-3 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              <Search className="size-[15px] shrink-0 text-meta" aria-hidden />
              <span className="sr-only">Search clients</span>
              <input
                name="q"
                type="search"
                defaultValue={q}
                placeholder="Search clients or groups"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-meta"
              />
            </label>
            {showSenior && vas.length > 0 && <SeniorFilter seniors={vas.map((v) => ({ id: v.id, name: v.name }))} value={va} />}
            <button type="submit" className="sr-only">
              Search
            </button>
            {q && (
              <Link href={clearHref} className="text-sm text-muted-foreground hover:text-foreground">
                Clear
              </Link>
            )}
          </form>
        }
      />

      <nav
        aria-label="Client lists"
        className="anim-rise anim-d1 inline-flex flex-wrap gap-1 self-start rounded-[14px] bg-[#ECEEF2] p-1"
      >
        {(Object.keys(TAB_LABELS) as ClientTab[]).map((t) => {
          const current = t === tab
          return (
            <Link
              key={t}
              href={href(t)}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'inline-flex h-9 items-center rounded-[10px] px-3.5 text-sm font-medium transition-[color,background,box-shadow] duration-200',
                current
                  ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(16,24,40,.08),0_4px_12px_-4px_rgba(16,24,40,.12)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {TAB_LABELS[t]}
              <span className="ml-2 font-mono text-xs opacity-75">{grouped[t].length}</span>
            </Link>
          )
        })}
      </nav>

      {tab === 'other' && (
        <div className="anim-rise anim-d2 flex items-start gap-3.5 rounded-2xl border bg-card px-[18px] py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-warning-soft">
            <CircleAlert className="size-[18px] text-warning" aria-hidden />
          </span>
          <div className="flex flex-col gap-1">
            <strong className="text-sm">WhatsApp groups with no HubSpot deal</strong>
            <p className="text-[13px] leading-normal text-muted-foreground">
              These are working groups that do not count as clients yet. Usually a new client whose deal is not linked.
              Once the deal is linked to the group, it moves to Clients.
            </p>
          </div>
        </div>
      )}

      {tab === 'past' && (
        <p className="anim-rise anim-d2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Groups whose HubSpot deal moved to Churned or AM Parked. Their history stays here and Ask Shadow can still answer
          from it. They raise no new tickets or alerts.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState>
          {q
            ? `Nothing in ${TAB_LABELS[tab]} matches "${q}".`
            : tab === 'clients'
              ? showSenior
                ? 'No clients with a HubSpot deal yet.'
                : 'No clients are assigned to you yet. Ask an Admin to assign clients.'
              : tab === 'other'
                ? 'Every active group has a HubSpot deal.'
                : 'No past clients.'}
        </EmptyState>
      ) : (
        <ClientsTable className="anim-rise anim-d2" rows={rows} showSenior={showSenior} footer={footer} />
      )}
    </div>
  )
}
