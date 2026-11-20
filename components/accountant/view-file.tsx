'use client'
// "View" for one client file: opens the copy synced to this laptop's OneDrive folder (the folder connected once in
// Push to NEO, lib/neo/local-folder.ts). PDFs, images and text open in a new tab; Excel, Word and other files
// download so the laptop's own app opens them. Nothing goes to Shadow's server.
import { useState } from 'react'
import { ExternalLink, Eye, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { findLocalFile, isUnreadable, opensInBrowser } from '@/lib/neo/handoff'
import { ensureReadAccess, loadFolder } from '@/lib/neo/local-folder'
import type { NeoFile } from './open-in-neo'

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  /** Found, but the browser did not allow a new tab without a fresh click (e.g. after a permission prompt). */
  | { kind: 'ready'; url: string; name: string }
  | { kind: 'message'; text: string }

const NO_FOLDER = 'Connect your OneDrive folder once: click Push to NEO, then Connect.'
const NO_ACCESS = 'The browser did not allow reading your OneDrive folder. Click View again and choose Allow.'
const NOT_FOUND = 'Not on this laptop yet. It may still be syncing. Push to NEO shows where Shadow looked.'
const NOT_DOWNLOADED = 'OneDrive has not downloaded this file yet. Set Client Files to Always keep on this device.'
const FAILED = 'Could not open the file. Try again, or use Push to NEO to choose it yourself.'

/** How long a file link stays valid: long enough to reload the opened tab, then the memory is freed. */
const LINK_LIFETIME_MS = 10 * 60_000

function fileLink(file: File): string {
  const url = URL.createObjectURL(file)
  setTimeout(() => URL.revokeObjectURL(url), LINK_LIFETIME_MS)
  return url
}

export function ViewFile({ file }: { file: NeoFile }) {
  const [state, setState] = useState<State>({ kind: 'idle' })

  async function onView() {
    setState({ kind: 'busy' })
    try {
      const folder = await loadFolder()
      if (!folder) return setState({ kind: 'message', text: NO_FOLDER })
      if (!(await ensureReadAccess(folder))) return setState({ kind: 'message', text: NO_ACCESS })
      const hit = await findLocalFile(folder, file)
      if (!hit) return setState({ kind: 'message', text: NOT_FOUND })
      if (isUnreadable(hit)) return setState({ kind: 'message', text: NOT_DOWNLOADED })

      const url = fileLink(hit.file)
      if (opensInBrowser(hit.file.type)) {
        // A new tab needs a recent click; a permission prompt can use it up, so offer a link to click instead.
        // No "noopener": it makes window.open return null, which would hide a blocked tab. Only PDFs, images and
        // plain text open here, so the tab runs no script.
        const win = navigator.userActivation?.isActive === false ? null : window.open(url, '_blank')
        setState(win ? { kind: 'idle' } : { kind: 'ready', url, name: hit.file.name })
        return
      }
      // Excel, Word, zip: download under the real name, so it opens in the laptop's app.
      const a = document.createElement('a')
      a.href = url
      a.download = hit.file.name
      a.click()
      setState({ kind: 'idle' })
    } catch {
      setState({ kind: 'message', text: FAILED })
    }
  }

  const busy = state.kind === 'busy'
  return (
    <span className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="xs" onClick={onView} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Eye aria-hidden />}
        View
      </Button>
      {state.kind === 'ready' && (
        <a href={state.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline">
          <ExternalLink className="size-3" aria-hidden />
          Open {state.name}
        </a>
      )}
      {state.kind === 'message' && (
        <span role="status" className="max-w-64 text-right text-xs text-warning">
          {state.text}
        </span>
      )}
    </span>
  )
}
