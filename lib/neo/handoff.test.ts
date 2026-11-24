import { describe, expect, it, vi } from 'vitest'
import {
  candidateFolders,
  candidateNames,
  DEFAULT_NEO_HANDOFF_URL,
  displayPath,
  findLocalFile,
  istDay,
  isUnreadable,
  MAX_HANDOFF_BYTES,
  neoErrorMessage,
  neoHandoffUrl,
  opensInBrowser,
  safeFolderName,
  sendToNeo,
  type FolderHandle,
} from './handoff'

describe('neoHandoffUrl', () => {
  it('defaults to the NEO loopback address and accepts only loopback hosts', () => {
    expect(neoHandoffUrl(undefined)).toBe(DEFAULT_NEO_HANDOFF_URL)
    expect(neoHandoffUrl('  ')).toBe(DEFAULT_NEO_HANDOFF_URL)
    expect(neoHandoffUrl('http://localhost:36363/handoff')).toBe('http://localhost:36363/handoff')
    expect(neoHandoffUrl('https://evil.example.com/handoff')).toBeNull()
    expect(neoHandoffUrl('http://127.0.0.1.evil.com/handoff')).toBeNull()
    expect(neoHandoffUrl('http://user:pw@127.0.0.1:36363/handoff')).toBeNull()
    expect(neoHandoffUrl('file:///etc/passwd')).toBeNull()
    expect(neoHandoffUrl('not a url')).toBeNull()
  })
})

describe('sendToNeo', () => {
  const file = new File(['hello'], 'purchases.xlsx', { type: 'application/vnd.ms-excel' })
  const url = DEFAULT_NEO_HANDOFF_URL

  it('posts the file and companyName as multipart, and returns the handoff id on 202', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as FormData
      expect(init?.method).toBe('POST')
      expect(body.get('companyName')).toBe('Acme Traders')
      expect((body.get('file') as File).name).toBe('purchases.xlsx')
      return new Response(JSON.stringify({ id: 'h-1' }), { status: 202 })
    })
    const r = await sendToNeo(file, '  Acme Traders ', { url, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toEqual({ ok: true, id: 'h-1' })
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.anything())
  })

  it('a 202 without a readable body still counts as sent', async () => {
    const fetchImpl = (async () => new Response('', { status: 202 })) as unknown as typeof fetch
    expect(await sendToNeo(file, 'A', { url, fetchImpl })).toEqual({ ok: true, id: null })
  })

  it('maps a network error, a timeout and an HTTP error to reasons, never throwing', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await sendToNeo(file, 'A', { url, fetchImpl: down })).toEqual({ ok: false, reason: 'unreachable' })

    const slow = (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }) as unknown as typeof fetch
    expect(await sendToNeo(file, 'A', { url, fetchImpl: slow })).toEqual({ ok: false, reason: 'timeout' })

    const refused = (async () => new Response('company not found\n', { status: 422 })) as unknown as typeof fetch
    const r = await sendToNeo(file, 'A', { url, fetchImpl: refused })
    expect(r).toEqual({ ok: false, reason: 'http', status: 422, detail: 'company not found' })
    if (!r.ok) expect(neoErrorMessage(r)).toBe('NEO refused the file (HTTP 422): company not found.')
  })

  it('refuses without calling NEO when the address is not allowed or the file is too big', async () => {
    const fetchImpl = vi.fn()
    expect(await sendToNeo(file, 'A', { url: null, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: false, reason: 'bad_config' })
    const big = { size: MAX_HANDOFF_BYTES + 1, name: 'big.pdf' } as unknown as File
    expect(await sendToNeo(big, 'A', { url, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: false, reason: 'too_large' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('explains an unreachable NEO in plain words, and warns against a blind resend', () => {
    expect(neoErrorMessage({ ok: false, reason: 'unreachable' })).toMatch(/open NEO and Tally/)
    expect(neoErrorMessage({ ok: false, reason: 'unreachable' })).toMatch(/before sending again/)
    expect(neoErrorMessage({ ok: false, reason: 'timeout' })).toMatch(/before sending it again/)
  })
})

describe('where va-bot saved the file', () => {
  it('cleans folder names the way va-bot does', () => {
    expect(safeFolderName('BridgeLine Partners <> VA')).toBe('BridgeLine Partners - VA')
    expect(safeFolderName('Acme × Co')).toBe('Acme - Co')
    expect(safeFolderName('A:B*C?')).toBe('ABC')
    expect(safeFolderName('  .Trailing.  ')).toBe('Trailing')
    expect(safeFolderName('')).toBe('unnamed')
    expect(safeFolderName('Acme\t<> VA')).toBe('Acme - VA') // tab and no-break space around <> (Python \s matches both)
  })

  it('istDay uses India time', () => {
    expect(istDay('2026-11-18T19:00:00Z')).toBe('2026-11-19')
    expect(istDay('2026-11-18T10:00:00Z')).toBe('2026-11-18')
    expect(istDay(null)).toBeNull()
    expect(istDay('bad')).toBeNull()
  })

  it('tries the date folder (and the day before) before the client folder, with and without Client Files and the parent', () => {
    const paths = candidateFolders({ folderName: 'KRRD', uploadedAt: '2026-11-19T05:00:00Z', parentFolder: 'KRRD Group' }).map((p) => p.join('/'))
    expect(paths.slice(0, 3)).toEqual(['Client Files/KRRD Group/KRRD/2026-11-19', 'Client Files/KRRD Group/KRRD/2026-11-18', 'Client Files/KRRD Group/KRRD'])
    expect(paths).toContain('KRRD/2026-11-19')
    expect(paths).toContain('KRRD')
    expect(new Set(paths).size).toBe(paths.length)

    // Older files: a full-history catch-up may have put them in a date folder; the client folder is still tried.
    const old = candidateFolders({ folderName: 'KRRD', uploadedAt: '2026-11-06T05:00:00Z' }).map((p) => p.join('/'))
    expect(old).toEqual([
      'Client Files/KRRD/2026-11-06',
      'Client Files/KRRD/2026-11-05',
      'Client Files/KRRD',
      'KRRD/2026-11-06',
      'KRRD/2026-11-05',
      'KRRD',
    ])
    const noTime = candidateFolders({ folderName: 'KRRD', uploadedAt: null }).map((p) => p.join('/'))
    expect(noTime).toEqual(['Client Files/KRRD', 'KRRD'])
  })

  it('splits an older folder_name that holds a path, without doubling Client Files', () => {
    const paths = candidateFolders({ folderName: 'Client Files/Alpha/', uploadedAt: null }).map((p) => p.join('/'))
    expect(paths).toEqual(['Client Files/Alpha', 'Alpha'])
  })

  it('candidateNames adds the _1, _2 names of later files with the same name', () => {
    expect(candidateNames('Invoice Oct.pdf', 2)).toEqual(['Invoice Oct.pdf', 'Invoice Oct_1.pdf', 'Invoice Oct_2.pdf'])
    expect(candidateNames('README', 1)).toEqual(['README', 'README_1'])
  })

  it('displayPath shows the most likely place', () => {
    expect(displayPath({ folderName: 'KRRD', uploadedAt: '2026-11-19T05:00:00Z', fileName: 'a.pdf' })).toBe('Client Files / KRRD / 2026-11-19 / a.pdf')
  })
})

/** A fake folder tree: paths like "Client Files/KRRD/2026-11-19/a.pdf" -> file size. */
function tree(files: Record<string, number>): FolderHandle {
  const make = (prefix: string): FolderHandle => ({
    async getDirectoryHandle(name) {
      const p = prefix ? `${prefix}/${name}` : name
      if (!Object.keys(files).some((f) => f.startsWith(`${p}/`))) throw new DOMException('not found', 'NotFoundError')
      return make(p)
    },
    async getFileHandle(name) {
      const p = prefix ? `${prefix}/${name}` : name
      if (!(p in files)) throw new DOMException('not found', 'NotFoundError')
      return { getFile: async () => new File([new Uint8Array(files[p])], name) }
    },
  })
  return make('')
}

describe('findLocalFile', () => {
  const f = { folderName: 'KRRD', uploadedAt: '2026-11-19T05:00:00Z', fileName: 'inv.pdf', fileSize: 10 }

  it('finds the file in the date folder under Client Files', async () => {
    const hit = await findLocalFile(tree({ 'Client Files/KRRD/2026-11-19/inv.pdf': 10 }), f)
    expect(hit).toMatchObject({ path: 'Client Files / KRRD / 2026-11-19 / inv.pdf', sizeMatches: true })
  })

  it('works when the connected folder is Client Files itself, and for files before date folders', async () => {
    expect(await findLocalFile(tree({ 'KRRD/2026-11-19/inv.pdf': 10 }), f)).toMatchObject({ path: 'KRRD / 2026-11-19 / inv.pdf' })
    expect(await findLocalFile(tree({ 'KRRD/inv.pdf': 10 }), { ...f, uploadedAt: '2026-11-01T05:00:00Z' })).toMatchObject({ path: 'KRRD / inv.pdf' })
  })

  it('skips a same-name file of another size and takes the _1 copy that matches', async () => {
    const hit = await findLocalFile(tree({ 'Client Files/KRRD/inv.pdf': 99, 'Client Files/KRRD/inv_1.pdf': 10 }), { ...f, uploadedAt: '2026-11-01T05:00:00Z' })
    expect(hit).toMatchObject({ path: 'Client Files / KRRD / inv_1.pdf', sizeMatches: true })
  })

  it('uses a single same-name file even when the logged size differs (WhatsApp sizes are not exact)', async () => {
    // Real case: va-bot logged 28665 bytes, the synced file is 37280.
    const one = await findLocalFile(tree({ 'Client Files/KRRD/2026-11-19/inv.pdf': 99 }), f)
    expect(one).toMatchObject({ path: 'Client Files / KRRD / 2026-11-19 / inv.pdf', sizeMatches: null })
  })

  it('warns only when two same-name files exist and neither has the logged size; null when nothing is there', async () => {
    const two = await findLocalFile(tree({ 'Client Files/KRRD/2026-11-19/inv.pdf': 99, 'Client Files/KRRD/2026-11-19/inv_1.pdf': 98 }), f)
    expect(two).toMatchObject({ path: 'Client Files / KRRD / 2026-11-19 / inv.pdf', sizeMatches: false })
    expect(await findLocalFile(tree({}), f)).toBeNull()
    expect(await findLocalFile(tree({ 'Client Files/KRRD/2026-11-19/inv.pdf': 10 }), { ...f, fileName: null })).toBeNull()
  })

  it('records where each attempt stopped, for the "What Shadow checked" details', async () => {
    const trace: string[] = []
    expect(await findLocalFile(tree({ 'KRRD/2026-11-18/other.pdf': 1 }), f, trace)).toBeNull()
    expect(trace).toContain('Client Files / KRRD / 2026-11-19: no folder "Client Files" (NotFoundError)')
    expect(trace).toContain('KRRD / 2026-11-19: no folder "2026-11-19" (NotFoundError)')
    expect(trace).toContain('KRRD / 2026-11-18: no file "inv.pdf" (NotFoundError)')
  })

  it('finds the library inside a higher folder (the whole OneDrive folder)', async () => {
    const files = { 'VA Documents - Documents/Client Files/KRRD/2026-11-19/inv.pdf': 10, 'Desktop/x.txt': 1 }
    const root = tree(files)
    const withEntries: FolderHandle = {
      ...root,
      async *values() {
        yield { kind: 'directory', name: 'Desktop' }
        yield { kind: 'directory', name: 'VA Documents - Documents' }
      },
    }
    expect(await findLocalFile(withEntries, f)).toMatchObject({ path: 'VA Documents - Documents / Client Files / KRRD / 2026-11-19 / inv.pdf', sizeMatches: true })
  })

  it('reports a file that is there but cannot be read (online-only, OneDrive stopped)', async () => {
    const root = tree({ 'Client Files/KRRD/2026-11-19/inv.pdf': 10 })
    const wrap = (d: FolderHandle): FolderHandle => ({
      async getDirectoryHandle(n) {
        return wrap(await d.getDirectoryHandle(n))
      },
      async getFileHandle(n) {
        await d.getFileHandle(n)
        return { getFile: async () => Promise.reject(new DOMException('cloud file provider not running', 'NotReadableError')) }
      },
    })
    const r = await findLocalFile(wrap(root), f)
    expect(isUnreadable(r)).toBe(true)
    expect(r).toEqual({ unreadable: 'Client Files / KRRD / 2026-11-19 / inv.pdf' })
  })

  it('without a known size, the first file found is used and marked unknown', async () => {
    const hit = await findLocalFile(tree({ 'Client Files/KRRD/2026-11-19/inv.pdf': 5 }), { ...f, fileSize: 0 })
    expect(hit).toMatchObject({ sizeMatches: null })
  })
})

describe('opensInBrowser', () => {
  it('opens PDFs, common images and plain text in a tab', () => {
    for (const t of ['application/pdf', 'image/png', 'image/JPEG', 'text/plain']) expect(opensInBrowser(t)).toBe(true)
  })
  it('downloads Office files, zips and unknown types', () => {
    const office = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    for (const t of [office, 'application/zip', '']) expect(opensInBrowser(t)).toBe(false)
  })
  it('never opens types that can run scripts from a Shadow tab', () => {
    for (const t of ['image/svg+xml', 'text/html', 'application/xhtml+xml']) expect(opensInBrowser(t)).toBe(false)
  })
})
