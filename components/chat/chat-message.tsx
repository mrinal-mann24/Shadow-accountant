'use client'

import type { UIMessage } from 'ai'
import { citedNumbers, splitCitations } from '@/lib/agent/citations'
import { cn } from '@/lib/utils'
import { CitationChip } from './citation-chip'
import { messageSources, messageText, plainText, type CitedSource } from './chat-utils'

/**
 * One chat turn. Assistant answers show [n] as chips and list the cited sources underneath.
 * `tone="dark"` is the Ask Shadow panel on the client page (ink background).
 */
export function ChatMessage({
  message,
  sources: shared,
  tone = 'light',
}: {
  message: UIMessage
  sources: Map<number, CitedSource>
  tone?: 'light' | 'dark'
}) {
  const dark = tone === 'dark'
  const text = messageText(message)
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p
          className={cn(
            'max-w-[85%] text-sm leading-normal break-words whitespace-pre-wrap',
            dark ? 'rounded-[14px_14px_4px_14px] bg-primary px-3 py-2.5 text-white' : 'rounded-xl bg-muted px-3 py-2',
          )}
        >
          {text}
        </p>
      </div>
    )
  }

  // Sources from this answer first, then earlier answers (the model may repeat an earlier number).
  const own = messageSources(message)
  const lookup = (n: number) => own.get(n) ?? shared.get(n)
  const cited = [...new Set(citedNumbers(text))].filter((n) => lookup(n))
  // Nothing written yet (tools still running): the typing dots show instead of an empty bubble.
  if (!text) return null

  return (
    <div
      className={cn(
        'flex flex-col gap-2.5',
        dark && 'max-w-[92%] rounded-[14px_14px_14px_4px] border border-ink-line bg-ink-2 p-3',
      )}
    >
      <div className={cn('text-sm leading-relaxed break-words whitespace-pre-wrap', dark && 'text-[#e5e8ee]')}>
        {splitCitations(plainText(text)).map((s, i) =>
          s.type === 'text' ? <span key={i}>{s.text}</span> : <CitationChip key={i} n={s.n} source={lookup(s.n)} tone={tone} />,
        )}
      </div>
      {cited.length > 0 && (
        <div className={cn('flex flex-col gap-1.5 border-t pt-2', dark ? 'border-ink-line' : 'border-border')}>
          <p className={cn('text-xs', dark ? 'text-[#9aa1af]' : 'text-muted-foreground')}>Sources</p>
          <div className="flex flex-wrap gap-1.5">
            {cited.map((n) => (
              <CitationChip key={n} n={n} source={lookup(n)} compact={false} tone={tone} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
