'use client'

import type { UIMessage } from 'ai'
import { citedNumbers, splitCitations } from '@/lib/agent/citations'
import { cn } from '@/lib/utils'
import { CitationChip } from './citation-chip'
import { messageSources, messageText, plainText, type CitedSource } from './chat-utils'

/** One chat turn. Assistant answers show [n] as chips and list the cited sources underneath. */
export function ChatMessage({ message, sources: shared }: { message: UIMessage; sources: Map<number, CitedSource> }) {
  const text = messageText(message)
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">{text}</p>
      </div>
    )
  }

  // Sources from this answer first, then earlier answers (the model may repeat an earlier number).
  const own = messageSources(message)
  const lookup = (n: number) => own.get(n) ?? shared.get(n)
  const cited = [...new Set(citedNumbers(text))].filter((n) => lookup(n))

  return (
    <div className="flex flex-col gap-2">
      <div className="whitespace-pre-wrap text-sm leading-relaxed">
        {splitCitations(plainText(text)).map((s, i) =>
          s.type === 'text' ? <span key={i}>{s.text}</span> : <CitationChip key={i} n={s.n} source={lookup(s.n)} />,
        )}
      </div>
      {cited.length > 0 && (
        <div className={cn('flex flex-col gap-1 border-t border-border pt-2')}>
          <p className="text-xs text-muted-foreground">Sources</p>
          <div className="flex flex-wrap gap-1">
            {cited.map((n) => (
              <CitationChip key={n} n={n} source={lookup(n)} compact={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
