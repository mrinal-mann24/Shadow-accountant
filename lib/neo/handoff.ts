// "Push to NEO": hands a client file from the Shadow web page to NEO running on the same laptop.
// Pure and browser-safe (no server imports), so it is unit tested.
//
// Why the browser: NEO listens only on the laptop (127.0.0.1). Shadow's server (Vercel) and the Teams bot cannot
// reach it; the Shadow page open on that laptop can. The file never leaves the laptop: it is read from the
// accountant's OneDrive-synced copy of the SharePoint library and posted to NEO on loopback.
//
// NEO contract (from the NEO team): POST <url> multipart { file, companyName } -> 202 { id }. NEO suggests the
// company in its picker and waits for the user to click Push to Tally.

export const DEFAULT_NEO_HANDOFF_URL = 'http://127.0.0.1:36363/handoff'
export const NEO_TIMEOUT_MS = 30_000
/** NEO's own limit is unknown; very large files are refused here with a clear message. */
export const MAX_HANDOFF_BYTES = 50 * 1024 * 1024

/**
 * The NEO handoff URL: NEXT_PUBLIC_NEO_HANDOFF_URL when set, else the default. Only a loopback http(s) URL is
 * accepted (127.0.0.1, localhost or [::1]): client files must never be posted anywhere else. Returns null when the
 * configured value is not allowed.
 */
export function neoHandoffUrl(configured: string | null | undefined): string | null {
  const raw = (configured ?? '').trim() || DEFAULT_NEO_HANDOFF_URL
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (!loopback || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null
  return u.toString()
}

export type NeoResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: 'unreachable' | 'timeout' | 'http' | 'too_large' | 'bad_config'; status?: number; detail?: string }

/** Sends one file to NEO. Never throws: every failure comes back as a reason the page can explain. */
export async function sendToNeo(
  file: Blob & { name?: string },
  companyName: string,
  o: { url: string | null; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<NeoResult> {
  if (!o.url) return { ok: false, reason: 'bad_config' }
  if (file.size > MAX_HANDOFF_BYTES) return { ok: false, reason: 'too_large' }
  const payload = new FormData()
  payload.append('file', file, file.name ?? 'file')
  payload.append('companyName', companyName.trim())

  const doFetch = o.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(o.url, { method: 'POST', body: payload, signal: AbortSignal.timeout(o.timeoutMs ?? NEO_TIMEOUT_MS) })
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, reason: 'timeout' }
    // A network error: NEO is not running, the browser blocked access to the local network, or NEO did not allow
    // this site (CORS). The browser does not say which.
    return { ok: false, reason: 'unreachable' }
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200)
    return { ok: false, reason: 'http', status: res.status, ...(detail ? { detail } : {}) }
  }
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null
  return { ok: true, id: typeof body?.id === 'string' ? body.id : null }
}

/** What to tell the accountant for a failed handoff. */
export function neoErrorMessage(r: Extract<NeoResult, { ok: false }>): string {
  switch (r.reason) {
    // The browser cannot tell "NEO is closed" from "NEO took the file but its answer was blocked", so the text
    // asks to look in NEO first: a blind retry could hand the same file over twice.
    case 'unreachable':
      return 'Could not confirm NEO got the file. If NEO is open, check whether the file is already there before sending again. If NEO is closed, open NEO and Tally here and try again. If the browser asks to allow access to apps or devices on your local network, choose Allow.'
    case 'timeout':
      return 'NEO did not answer in time. Check in NEO whether the file arrived before sending it again.'
    case 'too_large':
      return 'This file is larger than 50 MB. Open it in NEO directly.'
    case 'bad_config':
      return 'The NEO address is not set up correctly. Ask an Engineer.'
    case 'http':
      return `NEO refused the file (HTTP ${r.status ?? '?'})${r.detail ? `: ${r.detail}` : ''}.`
  }
}

// ---------------------------------------------------------------- where the file is on the laptop

/** Same rule as va-bot storage_sharepoint._safe_name, so folder names match the synced SharePoint library. */
export function safeFolderName(name: string | null | undefined): string {
  let n = (name ?? '').trim()
  n = n.replace(/\s*<>\s*/g, ' - ').replace(/\s*×\s*/g, ' - ')
  n = n.replace(/["*:<>?/\\|]/g, '')
  n = n.replace(/ {2,}/g, ' ').replace(/^[. ]+|[. ]+$/g, '')
  return n || 'unnamed'
}

/** va-bot puts files in a date sub-folder from this IST day on (config.DATE_FOLDERS_FROM). */
export const DATE_FOLDERS_FROM = '2026-11-18'
/** SharePoint folder that holds every client folder (config.SHAREPOINT_ROOT_FOLDER). */
export const CLIENT_FILES_ROOT = 'Client Files'

const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })

/** YYYY-MM-DD in IST, or null for a missing or bad time. */
export function istDay(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : IST_DAY.format(d)
}

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Folder paths (segments, without the file name) where va-bot may have saved a file, most likely first:
 * [Client Files /] [parent folder /] client folder [/ YYYY-MM-DD]. The accountant may have connected the library
 * root or the "Client Files" folder itself, so both are tried. The date folder is the IST day of the WhatsApp
 * message (uploaded_at is logged right after it); the day before is tried too for files saved around midnight.
 */
export function candidateFolders(f: { folderName: string; uploadedAt: string | null; parentFolder?: string | null }): string[][] {
  // folder_name is normally the client folder alone ("KRRD"); an older row may hold a path ("Client Files/KRRD/").
  const parts = f.folderName.split('/').map((p) => p.trim()).filter(Boolean)
  const clientParts = (parts[0] === CLIENT_FILES_ROOT ? parts.slice(1) : parts).map(safeFolderName)
  const client = clientParts.length ? clientParts : [safeFolderName(f.folderName)]
  const parent = f.parentFolder ? safeFolderName(f.parentFolder) : null
  const day = istDay(f.uploadedAt)
  const days = day && day >= DATE_FOLDERS_FROM ? [day, shiftDay(day, -1)].filter((d) => d >= DATE_FOLDERS_FROM) : []
  const bases: string[][] = parent && client.length === 1 ? [[parent, ...client], client] : [client]
  const out: string[][] = []
  const seen = new Set<string>()
  for (const prefix of [[CLIENT_FILES_ROOT], []]) {
    for (const base of bases) {
      for (const d of [...days, null]) {
        const path = [...prefix, ...base, ...(d ? [d] : [])]
        const key = path.join('/')
        if (!seen.has(key)) {
          seen.add(key)
          out.push(path)
        }
      }
    }
  }
  return out
}

/** The file name and the "_1", "_2" ... names va-bot gives a second file with the same name in one folder. */
export function candidateNames(fileName: string, extra = 3): string[] {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  return [fileName, ...Array.from({ length: extra }, (_, i) => `${stem}_${i + 1}${ext}`)]
}

/** The path the accountant would see, for the "choose it yourself" hint. */
export function displayPath(f: { folderName: string; uploadedAt: string | null; parentFolder?: string | null; fileName: string | null }): string {
  const [first] = candidateFolders(f)
  return [...first, f.fileName ?? ''].filter(Boolean).join(' / ')
}

/** A read-only view of a folder, as the File System Access API gives it (and as tests fake it). */
export type FolderHandle = {
  name?: string
  kind?: string
  getDirectoryHandle(name: string): Promise<FolderHandle>
  getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>
  /** Child entries (Chromium FileSystemDirectoryHandle); used to find the synced library inside a higher folder. */
  values?(): AsyncIterable<{ kind: string; name: string }>
}

export type FoundFile = { file: File; path: string; sizeMatches: boolean | null }
/** The file is there but could not be read: usually online-only with OneDrive stopped or not downloaded yet. */
export type UnreadableFile = { unreadable: string }
export type FindResult = FoundFile | UnreadableFile | null

export const isUnreadable = (r: FindResult): r is UnreadableFile => !!r && 'unreadable' in r

/** Types "View" opens in a browser tab. Others (Excel, Word, zip) download so the laptop's own app opens them.
 *  SVG and HTML are left out on purpose: a client-sent file opened from a Shadow tab must not run scripts. */
const BROWSER_VIEW_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'text/plain'])
export const opensInBrowser = (type: string): boolean => BROWSER_VIEW_TYPES.has(type.toLowerCase())

/** How the synced SharePoint library folder starts ("VA Documents - Documents"). */
const LIBRARY_PREFIX = 'va documents'

const errName = (e: unknown) => (e instanceof Error ? e.name || e.message : String(e))

async function findUnder(
  root: FolderHandle,
  prefix: string[],
  f: { folderName: string; uploadedAt: string | null; parentFolder?: string | null; fileName: string; fileSize: number | null },
  trace: string[],
): Promise<FindResult> {
  // The size WhatsApp reported (logged by va-bot) is not always the size of the saved file, so it only decides
  // between two files with the same name ("x.pdf" and "x_1.pdf"); a single match is used without a warning.
  const knownSize = typeof f.fileSize === 'number' && f.fileSize > 0 ? f.fileSize : null
  const matches: FoundFile[] = []
  let unreadable: UnreadableFile | null = null
  for (const folder of candidateFolders(f)) {
    let dir: FolderHandle = root
    let reached = true
    for (const part of folder) {
      try {
        dir = await dir.getDirectoryHandle(part)
      } catch (e) {
        trace.push(`${[...prefix, ...folder].join(' / ')}: no folder "${part}" (${errName(e)})`)
        reached = false
        break
      }
    }
    if (!reached) continue
    for (const name of candidateNames(f.fileName)) {
      let handle: { getFile(): Promise<File> }
      try {
        handle = await dir.getFileHandle(name)
      } catch (e) {
        if (name === f.fileName) trace.push(`${[...prefix, ...folder].join(' / ')}: no file "${name}" (${errName(e)})`)
        continue
      }
      const path = [...prefix, ...folder, name].join(' / ')
      let file: File
      try {
        file = await handle.getFile()
      } catch (e) {
        trace.push(`${path}: found but not readable (${errName(e)})`)
        unreadable ??= { unreadable: path } // there, but OneDrive could not hand it over
        continue
      }
      if (knownSize !== null && file.size === knownSize) return { file, path, sizeMatches: true }
      matches.push({ file, path, sizeMatches: knownSize === null ? null : false })
    }
    if (matches.length) break // the most likely folder had it: do not mix in copies from less likely folders
  }
  if (matches.length === 1) return { ...matches[0], sizeMatches: null }
  return matches[0] ?? unreadable
}

/**
 * Finds the file under the connected folder. When the logged size is known, a file whose size differs is skipped
 * (it is another file with the same name) and the "_1", "_2" names are tried. Works when the connected folder is
 * "Client Files", the library folder above it, or a higher folder that holds the library ("VA Documents - ...").
 * Returns null when nothing is there, or { unreadable } when the file is there but could not be read.
 */
export async function findLocalFile(
  root: FolderHandle,
  f: { folderName: string; uploadedAt: string | null; parentFolder?: string | null; fileName: string | null; fileSize: number | null },
  /** Filled with one line per place checked and why it failed, for the "What Shadow checked" details. */
  trace: string[] = [],
): Promise<FindResult> {
  if (!f.fileName) return null
  const file = { ...f, fileName: f.fileName }
  const direct = await findUnder(root, [], file, trace)
  if (direct && !isUnreadable(direct)) return direct
  // A higher folder (for example the whole OneDrive folder): look inside the synced library folder(s).
  if (root.values) {
    try {
      for await (const entry of root.values()) {
        if (entry.kind !== 'directory' || !entry.name.toLowerCase().startsWith(LIBRARY_PREFIX)) continue
        const hit = await findUnder(await root.getDirectoryHandle(entry.name), [entry.name], file, trace)
        if (hit && !isUnreadable(hit)) return hit
      }
    } catch (e) {
      trace.push(`Could not list the connected folder (${errName(e)})`)
    }
  }
  return direct
}
