import Link from 'next/link'
import { headers } from 'next/headers'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ViewAsSelector } from '@/components/shell/view-as-selector'
import { EmptyState, LoadError, PageHeader, Section, Stat } from '@/components/admin/states'
import { formatAgo, formatDateTime, isStale } from '@/components/admin/format'
import { CouncilToggle } from '@/components/engineer/council-toggle'
import { jobHints } from '@/components/engineer/job-hints'
import { RetryButton } from '@/components/engineer/retry-button'
import { formatLatency } from '@/components/engineer/usage'
import { requireUser } from '@/lib/auth/session'
import { listViewAsOptions } from '@/lib/auth/view-as'
import { getCouncilUsage, getSystemHealth, listClients, type ClientListItem, type CouncilUsageReport, type SystemHealth } from '@/lib/data'
import { jobsWriteEnabled } from '@/lib/jobs/guard'

export const metadata = { title: 'System' }

// Thresholds after which a source reads as late (minutes).
const LATE = { whatsapp: 6 * 60, score: 26 * 60, council: 2 * 60, hubspot: 60 }
const USAGE_WINDOW_DAYS = 30

function settled<T>(r: PromiseSettledResult<T>, label: string): T | null {
  if (r.status === 'fulfilled') return r.value
  console.error(`[engineer] ${label} failed`, r.reason)
  return null
}

async function baseUrl(): Promise<string | null> {
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  if (!host) return null
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  return `${proto}://${host}`
}

export default async function EngineerPage() {
  const user = await requireUser(['engineer'])
  const [healthR, clientsR, usageR, viewAsR] = await Promise.allSettled([
    getSystemHealth(user),
    listClients(user),
    getCouncilUsage(user, USAGE_WINDOW_DAYS),
    listViewAsOptions(),
  ])
  const health = settled(healthR, 'system health')
  const clients = settled(clientsR, 'clients')
  const usage = settled(usageR, 'council usage')
  const viewAs = settled(viewAsR, 'view as options')
  const hints = jobHints(await baseUrl())
  const writing = hints.filter((j) => jobsWriteEnabled(j.key)).map((j) => j.key)
  const writes = writing.length > 0
  const now = new Date()

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader title="System" description="Data sources, failed processing, the ticket council, jobs and AI usage.">
        <Badge variant={writes ? 'destructive' : 'secondary'}>{writes ? `Job writes are ON (${writing.length} of ${hints.length})` : 'Jobs are in dry-run mode'}</Badge>
      </PageHeader>

      <Section title="Data sources" description="When each source last produced data.">
        {!health ? (
          <LoadError what="system health" />
        ) : (
          <DataSources health={health} now={now} />
        )}
      </Section>

      <Section
        title="Failed processing"
        description="Messages the council could not process. Retry puts a message back in the queue for the next council run."
      >
        {!health ? (
          <LoadError what="failed processing rows" />
        ) : (
          <FailedRows health={health} now={now} />
        )}
      </Section>

      <Section
        title="Ticket council per client"
        description="Only clients with the council on get tickets from WhatsApp. Turn it on a few clients at a time."
      >
        {!clients ? <LoadError what="clients" /> : <CouncilTable clients={clients} />}
      </Section>

      <Section
        title="Run a job by hand"
        description={
          <>
            Each job needs the cron secret. Set it in your shell as <code>CRON_SECRET</code> first; never paste the secret
            into chat, tickets or this page. {writes ? (
              <strong className="text-destructive">Writes are ON for {writing.join(', ')}: those commands change data.</strong>
            ) : (
              <>
                Writes are off (a job writes only when <code>JOBS_WRITE_ENABLED</code> is true and the job is listed in{' '}
                <code>JOBS_WRITE_ONLY</code>), so every run is a dry run and only reports.
              </>
            )}
          </>
        }
      >
        <ul className="flex flex-col gap-4">
          {hints.map((j) => (
            <li key={j.key}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{j.label}</span>
                <span className="text-xs text-muted-foreground">{j.schedule}</span>
                {jobsWriteEnabled(j.key) && <Badge variant="destructive">Writes ON</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">{j.description}</p>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                <code>{j.command}</code>
              </pre>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title={`AI usage, last ${USAGE_WINDOW_DAYS} days`}
        description="From council verdicts. Cost is not tracked yet: verdicts store the model and latency only, not tokens or price."
      >
        {!usage ? <LoadError what="AI usage" /> : <Usage usage={usage} now={now} />}
      </Section>

      <Section
        title="View as an accountant"
        description="See the app exactly as one accountant sees it. Read only: changes are turned off until you stop viewing as. Use the banner at the top to stop."
      >
        {!viewAs ? (
          <LoadError what="the accountant list" />
        ) : viewAs.length === 0 ? (
          <EmptyState>No accountants to view as.</EmptyState>
        ) : (
          <ViewAsSelector options={viewAs} />
        )}
      </Section>
    </div>
  )
}

function DataSources({ health, now }: { health: SystemHealth; now: Date }) {
  const lastVerdictAt = health.lastCouncilVerdictAt
  const wa = isStale(health.lastMessageAt, now, LATE.whatsapp)
  const score = isStale(health.lastScoreRunAt, now, LATE.score)
  const council = health.councilClients.length > 0 && isStale(lastVerdictAt, now, LATE.council)
  const hub = isStale(health.hubspotLastSync, now, LATE.hubspot)
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="Last WhatsApp message"
        value={formatAgo(health.lastMessageAt, now)}
        tone={wa ? 'warning' : 'default'}
        hint={
          <>
            {formatDateTime(health.lastMessageAt)}. {health.messagesLast24h} in the last 24 h.
            {wa && ' Check that va-bot is running.'}
          </>
        }
      />
      <Stat
        label="Last health score run"
        value={formatAgo(health.lastScoreRunAt, now)}
        tone={score ? 'warning' : 'default'}
        hint={formatDateTime(health.lastScoreRunAt)}
      />
      <Stat
        label="Last council verdict"
        value={formatAgo(lastVerdictAt, now)}
        tone={council ? 'warning' : 'default'}
        hint={
          <>
            {formatDateTime(lastVerdictAt)}. Council on for{' '}
            {health.councilClients.length} client(s).
          </>
        }
      />
      <Stat
        label="Last HubSpot sync"
        value={formatAgo(health.hubspotLastSync, now)}
        tone={hub ? 'warning' : 'default'}
        hint={health.hubspotLastSync ? formatDateTime(health.hubspotLastSync) : 'Not recorded. Dry runs do not record a sync time.'}
      />
      <Stat
        label="Council backlog"
        value={health.processing.councilBacklog}
        hint={`Messages from council clients not processed yet.${
          health.processing.pending > 0 ? ` ${health.processing.pending} put back for retry.` : ''
        }`}
      />
      <Stat
        label="Failed processing"
        value={health.processing.failed}
        tone={health.processing.failed > 0 ? 'danger' : 'default'}
        hint="Messages with status failed"
      />
      <Stat
        label="Team numbers known"
        value={health.teamNumbersCount}
        tone={health.teamNumbersCount < 10 ? 'warning' : 'default'}
        hint={
          health.teamNumbersCount < 10
            ? 'Too few: team replies read as incoming until the team_whatsapp_numbers setting is filled.'
            : 'Used to tell team replies from client messages.'
        }
      />
    </div>
  )
}

function FailedRows({ health, now }: { health: SystemHealth; now: Date }) {
  const rows = health.processing.recentFailures
  if (rows.length === 0) return <EmptyState>No failed messages. Nothing to retry.</EmptyState>
  return (
    <>
      {health.processing.failed > rows.length && (
        <p className="mb-2 text-xs text-muted-foreground">
          Showing the newest {rows.length} of {health.processing.failed}.
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Message</TableHead>
            <TableHead>Error</TableHead>
            <TableHead className="text-right">Attempts</TableHead>
            <TableHead>First seen</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Action</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.messageId}>
              <TableCell className="font-mono text-xs">{r.messageId}</TableCell>
              <TableCell className="max-w-md">
                <span className="line-clamp-2 text-xs whitespace-normal text-muted-foreground" title={r.error ?? undefined}>
                  {r.error ?? 'No error text'}
                </span>
              </TableCell>
              <TableCell className={`text-right tabular-nums ${r.attempts >= r.maxAttempts ? 'text-destructive' : ''}`}>
                {r.attempts} of {r.maxAttempts}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{formatAgo(r.createdAt, now)}</TableCell>
              <TableCell className="text-right">
                <RetryButton messageId={r.messageId} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  )
}

function CouncilTable({ clients }: { clients: ClientListItem[] }) {
  if (clients.length === 0) return <EmptyState>No clients yet.</EmptyState>
  const sorted = [...clients].sort(
    (a, b) => Number(b.councilEnabled) - Number(a.councilEnabled) || a.name.localeCompare(b.name),
  )
  const on = clients.filter((c) => c.councilEnabled).length
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">
        On for {on} of {clients.length} clients.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Client</TableHead>
            <TableHead>Accountant</TableHead>
            <TableHead>WhatsApp group</TableHead>
            <TableHead className="text-right">Council</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link href={`/clients/${c.id}`} className="font-medium underline-offset-2 hover:underline">
                  {c.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{c.vaName ?? 'Unassigned'}</TableCell>
              <TableCell className="text-muted-foreground">
                {c.whatsappGroupName ?? <span className="text-warning">No group: nothing to process</span>}
              </TableCell>
              <TableCell>
                <CouncilToggle clientId={c.id} clientName={c.name} enabled={c.councilEnabled} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  )
}

function Usage({ usage, now }: { usage: CouncilUsageReport; now: Date }) {
  if (usage.verdicts === 0) {
    return (
      <EmptyState>
        No council verdicts in the last {usage.windowDays} days ({usage.totalVerdicts} in total, the newest{' '}
        {formatAgo(usage.lastVerdictEverAt, now)}).
      </EmptyState>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Verdicts" value={usage.verdicts} hint={`${usage.totalVerdicts} in total`} />
        <Stat label="Model calls" value={usage.verdicts * 2} hint="Two models per verdict, retries not counted" />
        <Stat label="Models agreed" value={usage.agreedPct === null ? 'None' : `${usage.agreedPct}%`} />
        <Stat label="Cost" value="Not tracked" hint="Tokens and price are not stored yet" />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Slot</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Avg latency</TableHead>
            <TableHead className="text-right">p95 latency</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {usage.models.map((m) => (
            <TableRow key={`${m.slot}:${m.model}`}>
              <TableCell>{m.slot}</TableCell>
              <TableCell className="font-mono text-xs">{m.model}</TableCell>
              <TableCell className="text-right tabular-nums">{m.calls}</TableCell>
              <TableCell className="text-right tabular-nums">{formatLatency(m.avgLatencyMs)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatLatency(m.p95LatencyMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap gap-2 text-sm">
        {usage.byDecision.map((d) => (
          <span key={d.decision} className="rounded-md border px-3 py-1">
            {d.decision.replace(/_/g, ' ')} <span className="tabular-nums text-muted-foreground">{d.count}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
