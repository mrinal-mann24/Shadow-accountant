// The accountant's OneDrive-synced client files folder, connected once in this browser (File System Access API,
// Chrome and Edge on a computer). The folder handle is kept in this browser's IndexedDB so the next "Open in NEO"
// finds files on its own; it never leaves the laptop. Browser only: used by components/accountant/open-in-neo.tsx.
import type { FolderHandle } from './handoff'

type Permission = 'granted' | 'denied' | 'prompt'
export type BrowserFolder = FolderHandle & {
  name: string
  queryPermission?(o: { mode: 'read' }): Promise<Permission>
  requestPermission?(o: { mode: 'read' }): Promise<Permission>
}

const DB = 'shadow-neo'
const STORE = 'handles'
const KEY = 'client-files-root'

/** True when this browser can connect a folder (Chrome or Edge on a computer). */
export function canConnectFolder(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** The connected folder, or null (none yet, storage blocked, or another browser). */
export async function loadFolder(): Promise<BrowserFolder | null> {
  try {
    return ((await withStore('readonly', (s) => s.get(KEY))) as BrowserFolder | undefined) ?? null
  } catch {
    return null
  }
}

/** Asks the accountant to pick the folder (needs a click). Returns null when they cancel. */
export async function connectFolder(): Promise<BrowserFolder | null> {
  const picker = (window as unknown as { showDirectoryPicker: (o: { id: string; mode: 'read' }) => Promise<BrowserFolder> }).showDirectoryPicker
  let folder: BrowserFolder
  try {
    folder = await picker({ id: 'shadow-client-files', mode: 'read' })
  } catch {
    return null // cancelled
  }
  try {
    await withStore('readwrite', (s) => s.put(folder, KEY))
  } catch {
    // Not remembered (private window or blocked storage): it still works for this visit.
  }
  return folder
}

/** Forgets the connected folder in this browser. */
export async function forgetFolder(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(KEY))
  } catch {
    // nothing stored
  }
}

/** Read access to a remembered folder. The browser may ask again after a restart (needs a click). */
export async function ensureReadAccess(folder: BrowserFolder): Promise<boolean> {
  try {
    if (!folder.queryPermission || !folder.requestPermission) return true
    if ((await folder.queryPermission({ mode: 'read' })) === 'granted') return true
    return (await folder.requestPermission({ mode: 'read' })) === 'granted'
  } catch {
    return false
  }
}
