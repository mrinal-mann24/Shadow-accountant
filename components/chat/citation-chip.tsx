'use client'

import Link from 'next/link'
import { ExternalLink, FileText, MessageSquare, Ticket, User, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { formatCitationTime, type CitationKind } from '@/lib/agent/citations'
import { cn } from '@/lib/utils'
import type { CitedSource } from './chat-utils'

const KIND_LABEL: Record<CitationKind, string> = {
  message: 'WhatsApp message',
  file: 'File',
  meeting: 'Meeting',
  ticket: 'Ticket',
  client: 'Client profile',
}

function KindIcon({ kind, className }: { kind: CitationKind; className?: string }) {
  const Icon = { message: MessageSquare, file: FileText, meeting: Video, ticket: Ticket, client: User }[kind] ?? FileText
  return <Icon className={className} aria-hidden />
}

/** In-app links only: never render a link from model or message text. */
function safeLink(link: string | undefined): string | null {
  return link && link.startsWith('/') && !link.startsWith('//') ? link : null
}

/** A numbered chip inside the answer. Opens the source: time, sender or file name, and the text it came from. */
export function CitationChip({ n, source, compact = true }: { n: number; source: CitedSource | undefined; compact?: boolean }) {
  if (!source) {
    return (
      <span className="mx-0.5 align-baseline text-xs text-muted-foreground" title="No source was returned for this number">
        [{n}]
      </span>
    )
  }
  const { citation, preview } = source
  const link = safeLink(citation.link)
  const when = formatCitationTime(citation.at)
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted align-baseline text-xs text-foreground hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-primary',
            compact ? 'px-1.5 py-0' : 'px-2 py-0.5',
          )}
          aria-label={`Source ${n}: ${citation.label}`}
        >
          <span className="font-medium">{n}</span>
          {!compact && (
            <>
              <KindIcon kind={citation.kind} className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{citation.label}</span>
            </>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <KindIcon kind={citation.kind} className="size-4 text-muted-foreground" />
            {KIND_LABEL[citation.kind] ?? 'Source'} [{n}]
          </DialogTitle>
          <DialogDescription>{citation.label}</DialogDescription>
        </DialogHeader>
        {when && <p className="text-xs text-muted-foreground">{when} (India time)</p>}
        {preview && (
          <blockquote className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border-l-2 border-border bg-muted/50 px-3 py-2 text-sm">
            {preview}
          </blockquote>
        )}
        {link && (
          <div className="flex justify-end">
            <Button asChild variant="outline" size="sm">
              <Link href={link}>
                <ExternalLink aria-hidden />
                Open in client page
              </Link>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
