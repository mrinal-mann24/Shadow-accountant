// "Files received" monthly checklist (AR / AP / Bank / Other) from document_uploads.
import { Check } from 'lucide-react'
import type { DocumentItem } from '@/lib/data/types'
import { buildFilesGrid, FILE_CATEGORY_LABELS, formatDateTime } from './logic'
import { EmptyState } from './ui'

export function FilesGrid({ documents, now }: { documents: DocumentItem[]; now: Date }) {
  if (documents.length === 0) return <EmptyState>No files received yet.</EmptyState>
  const grid = buildFilesGrid(documents, now, 6)
  const recent = documents.filter((d) => d.uploadedAt).slice(0, 5)

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-sm">
          <caption className="sr-only">Files received per month by type</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="py-1.5 pr-2 text-left font-medium">
                Type
              </th>
              {grid.months.map((m) => (
                <th key={m.key} scope="col" className="px-1 py-1.5 text-center font-medium">
                  {m.label.replace(/ \d{4}$/, '')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r) => (
              <tr key={r.category} className="border-t">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                  {FILE_CATEGORY_LABELS[r.category]}
                </th>
                {r.counts.map((n, i) => (
                  <td key={grid.months[i].key} className="px-1 py-1.5 text-center tabular-nums">
                    {n > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-success" title={`${n} files`}>
                        <Check className="size-3.5" aria-hidden />
                        {n}
                      </span>
                    ) : (
                      <span className="text-muted-foreground" aria-label="None">
                        -
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Type is a best guess from the folder and file name. Months in IST.
        {grid.older > 0 && ` ${grid.older} older ${grid.older === 1 ? 'file' : 'files'} not shown.`}
      </p>
      {recent.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Latest files</p>
          <ul className="space-y-1 text-sm">
            {recent.map((d) => (
              <li key={d.id} className="flex flex-wrap justify-between gap-x-3">
                <span className="min-w-0 break-all">{d.fileName ?? d.path}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(d.uploadedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
