// "Files received" monthly checklist (AR / AP / Bank / Other) from document_uploads, and the latest files with
// "View" (components/accountant/view-file.tsx) and "Push to NEO" (components/accountant/open-in-neo.tsx) buttons each
// when the page passes `neo`.
import { Check } from 'lucide-react'
import type { DocumentItem } from '@/lib/data/types'
import { buildFilesGrid, FILE_CATEGORY_LABELS, formatDateTime } from './logic'
import { OpenInNeo, type NeoFile } from './open-in-neo'
import { ViewFile } from './view-file'
import { EmptyState } from './ui'

/** Latest files listed under the grid. */
export const RECENT_FILES = 10

export type FilesNeoContext = { clientId: string; clientName: string; companyName: string; parentFolder: string | null }

function neoFile(neo: FilesNeoContext, d: DocumentItem): NeoFile {
  return {
    id: d.id,
    clientId: neo.clientId,
    clientName: neo.clientName,
    fileName: d.fileName,
    folderName: d.folderName,
    parentFolder: neo.parentFolder,
    uploadedAt: d.uploadedAt,
    fileSize: d.fileSize,
    companyName: neo.companyName,
  }
}

/** View first (check the file), then Push to NEO. */
function FileActions({ file }: { file: NeoFile }) {
  return (
    <span className="flex items-start gap-2">
      <ViewFile file={file} />
      <OpenInNeo file={file} />
    </span>
  )
}

/** The latest files, plus the focused one (from a Teams View link) when newer files pushed it out. */
export function recentFiles(documents: DocumentItem[], focusId?: string | null): DocumentItem[] {
  const recent = documents.filter((d) => d.uploadedAt).slice(0, RECENT_FILES)
  const focused = focusId ? documents.find((d) => d.id === focusId) : undefined
  return focused && !recent.includes(focused) ? [...recent, focused] : recent
}

export function FilesGrid({
  documents,
  now,
  neo,
  focusId,
}: {
  documents: DocumentItem[]
  now: Date
  neo?: FilesNeoContext
  /** Upload id to highlight (from a Teams View link). */
  focusId?: string | null
}) {
  if (documents.length === 0) return <EmptyState>No files received yet.</EmptyState>
  const grid = buildFilesGrid(documents, now, 6)
  const recent = recentFiles(documents, focusId)

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
              <li
                key={d.id}
                id={`file-${d.id}`}
                aria-current={d.id === focusId ? 'true' : undefined}
                className={`flex scroll-mt-20 flex-wrap items-center justify-between gap-x-3 gap-y-1 ${
                  d.id === focusId ? '-mx-2 rounded-md bg-primary/10 px-2 py-1 ring-1 ring-primary/40' : ''
                }`}
              >
                <span className="min-w-0 flex-1 break-all">{d.fileName ?? d.path}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{formatDateTime(d.uploadedAt)}</span>
                  {neo && d.fileName && <FileActions file={neoFile(neo, d)} />}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
