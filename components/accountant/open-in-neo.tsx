'use client'
// "Open in NEO" for one client file: finds the file in the accountant's OneDrive-synced folder on this laptop (or
// lets them choose it), shows it, and hands it to NEO running on this laptop (lib/neo/handoff.ts). Nothing is sent
// to Shadow's server: the file goes from this browser straight to NEO on 127.0.0.1.
import { useEffect, useId, useRef, useState } from 'react'
import { CheckCircle2, ExternalLink, FolderOpen, Loader2, Send, TriangleAlert, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { displayPath, findLocalFile, neoErrorMessage, neoHandoffUrl, sendToNeo, type FoundFile } from '@/lib/neo/handoff'
import { canConnectFolder, connectFolder, ensureReadAccess, forgetFolder, loadFolder, type BrowserFolder } from '@/lib/neo/local-folder'

export type NeoFile = {
  id: string
  clientId: string
  clientName: string
  fileName: string | null
  folderName: string
  parentFolder: string | null
  uploadedAt: string | null
  fileSize: number | null
  /** Suggested Tally company name (legal name, else client name). NEO suggests the closest match. */
  companyName: string
}

const NEO_URL = neoHandoffUrl(process.env.NEXT_PUBLIC_NEO_HANDOFF_URL)
const companyKey = (clientId: string) => `shadow-neo-company:${clientId}`

function readCompany(clientId: string, fallback: string): string {
  try {
    return window.localStorage.getItem(companyKey(clientId)) || fallback
  } catch {
    return fallback
  }
}

function rememberCompany(clientId: string, name: string): void {
  try {
    window.localStorage.setItem(companyKey(clientId), name)
  } catch {
    // per-browser convenience only
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const isImage = (f: File) => f.type.startsWith('image/')
const isPdf = (f: File) => f.type === 'application/pdf'

type Status =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'not_found' }
  | { kind: 'no_access' }
  | { kind: 'sending' }
  | { kind: 'sent'; id: string | null }
  | { kind: 'error'; message: string }

export function OpenInNeo({ file }: { file: NeoFile }) {
  const [open, setOpen] = useState(false)
  const [folder, setFolder] = useState<BrowserFolder | null>(null)
  const [found, setFound] = useState<FoundFile | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [company, setCompany] = useState(file.companyName)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [folderSupported, setFolderSupported] = useState(false)
  const pickerRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<string | null>(null)
  // Bumped when the dialog closes or a new search starts, so a slow search never fills a closed or newer dialog.
  const runRef = useRef(0)
  const companyId = useId()
  const confirmId = useId()
  const hint = displayPath(file)

  /** Shows a file (or none), with a preview link for PDFs and images; the previous link is released. */
  function show(next: FoundFile | null) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    const url = next && (isImage(next.file) || isPdf(next.file)) ? URL.createObjectURL(next.file) : null
    urlRef.current = url
    setPreviewUrl(url)
    setFound(next)
    setChecked(false)
  }

  // Release the preview link when the component goes away.
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  // Opening the dialog: load the remembered folder; search when access is already granted (asking again needs a
  // click, so that waits for the Find button).
  useEffect(() => {
    if (!open) return
    const run = runRef.current
    void (async () => {
      const f = await loadFolder()
      if (runRef.current !== run || !f) return
      setFolder(f)
      const granted = f.queryPermission ? (await f.queryPermission({ mode: 'read' }).catch(() => 'prompt')) === 'granted' : true
      if (runRef.current === run && granted) await search(f)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function search(f: BrowserFolder) {
    const run = ++runRef.current
    setStatus({ kind: 'searching' })
    const hit = await findLocalFile(f, file).catch(() => null)
    if (runRef.current !== run) return // closed, or another search started
    show(hit)
    setStatus(hit ? { kind: 'idle' } : { kind: 'not_found' })
  }

  async function onFind() {
    let f = folder
    if (!f) {
      f = await connectFolder()
      if (!f) return
      setFolder(f)
    }
    if (!(await ensureReadAccess(f))) {
      setStatus({ kind: 'no_access' })
      return
    }
    await search(f)
  }

  async function onChangeFolder() {
    await forgetFolder()
    setFolder(null)
    show(null)
    const f = await connectFolder()
    if (!f) return
    setFolder(f)
    await search(f)
  }

  function onPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return
    runRef.current++ // a running folder search must not replace the chosen file
    const knownSize = file.fileSize && file.fileSize > 0 ? file.fileSize : null
    show({ file: picked, path: picked.name, sizeMatches: knownSize === null ? null : picked.size === knownSize })
    setStatus({ kind: 'idle' })
  }

  async function onSend() {
    if (!found || !company.trim()) return
    setStatus({ kind: 'sending' })
    const r = await sendToNeo(found.file, company, { url: NEO_URL })
    if (r.ok) {
      rememberCompany(file.clientId, company.trim())
      setStatus({ kind: 'sent', id: r.id })
    } else {
      setStatus({ kind: 'error', message: neoErrorMessage(r) })
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    runRef.current++
    if (next) {
      // The remembered company name for this client, and whether this browser can connect a folder.
      setCompany(readCompany(file.clientId, file.companyName))
      setFolderSupported(canConnectFolder())
    } else {
      show(null)
      setStatus({ kind: 'idle' })
    }
  }

  const busy = status.kind === 'searching' || status.kind === 'sending'
  const sent = status.kind === 'sent'
  // A file whose size differs from what WhatsApp sent may be another file with the same name: confirm it first.
  const needsConfirm = found?.sizeMatches === false
  const canSend = !!found && !!company.trim() && !busy && !sent && (!needsConfirm || checked)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="xs">
          <Send aria-hidden />
          Open in NEO
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Open in NEO</DialogTitle>
          <DialogDescription>
            Sends this file to NEO on this computer. NEO and Tally must be open here. Nothing is posted to Tally until you
            click Push to Tally in NEO.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <div className="rounded-md border p-3">
            <p className="break-all font-medium">{file.fileName ?? 'Unnamed file'}</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">Usually in your OneDrive at: {hint}</p>
          </div>

          {/* 1. The file */}
          {found ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5">
                <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                <span className="min-w-0 break-all">
                  {found.path} ({formatSize(found.file.size)})
                </span>
              </p>
              {needsConfirm && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-warning">
                  <p className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    This file&apos;s size is not the size WhatsApp sent, so it may be a different file with the same name.
                  </p>
                  <label htmlFor={confirmId} className="mt-2 flex items-center gap-2 text-foreground">
                    <input id={confirmId} type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                    I have checked this is the right file
                  </label>
                </div>
              )}
              {previewUrl && isImage(found.file) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl} alt={`Preview of ${found.file.name}`} className="max-h-80 w-auto self-start rounded-md border object-contain" />
              )}
              {previewUrl && isPdf(found.file) && (
                <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm underline">
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open the PDF to check it
                </a>
              )}
            </div>
          ) : status.kind === 'searching' ? (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Looking in your OneDrive folder...
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {status.kind === 'not_found' && (
                <p className="text-warning">
                  Not found in the connected folder. It may still be syncing, or the folder may be a different one. Choose it
                  yourself, or connect another folder.
                </p>
              )}
              {status.kind === 'no_access' && <p className="text-warning">The browser did not allow reading the folder. Try again, or choose the file yourself.</p>}
              <div className="flex flex-wrap gap-2">
                {folderSupported && (
                  <Button type="button" variant="outline" size="sm" onClick={onFind} disabled={busy}>
                    <FolderOpen aria-hidden />
                    {folder ? 'Find in my OneDrive folder' : 'Connect my OneDrive folder'}
                  </Button>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => pickerRef.current?.click()} disabled={busy}>
                  <Upload aria-hidden />
                  Choose file
                </Button>
              </div>
              {folderSupported && !folder && (
                <p className="text-xs text-muted-foreground">
                  Connect once: pick your synced &quot;Client Files&quot; folder (or the library folder above it). Shadow then finds
                  each file by itself. The folder stays on this computer.
                </p>
              )}
            </div>
          )}
          <input ref={pickerRef} type="file" className="hidden" onChange={onPicked} aria-hidden tabIndex={-1} />

          {/* 2. The Tally company */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={companyId}>Tally company</Label>
            <Input id={companyId} value={company} onChange={(e) => setCompany(e.target.value)} disabled={busy || sent} maxLength={200} />
            <p className="text-xs text-muted-foreground">NEO suggests the closest company in its list; you confirm it there.</p>
          </div>

          {status.kind === 'error' && (
            <p role="alert" className="flex items-start gap-1.5 text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {status.message}
            </p>
          )}
          {sent && (
            <p role="status" className="flex items-start gap-1.5 text-success">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              Sent to NEO. In NEO, check the company and click Push to Tally.
              {status.id ? ` (Reference ${status.id})` : ''}
            </p>
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {folder && found && !sent && (
            <Button type="button" variant="ghost" size="sm" onClick={onChangeFolder} disabled={busy}>
              Use another folder
            </Button>
          )}
          <Button type="button" onClick={onSend} disabled={!canSend}>
            {status.kind === 'sending' ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            {sent ? 'Sent' : 'Send to NEO'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
