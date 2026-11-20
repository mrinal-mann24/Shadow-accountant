import { describe, expect, it } from 'vitest'
import type { DocumentItem } from '@/lib/data/types'
import { RECENT_FILES, recentFiles } from './files-grid'

const doc = (i: number): DocumentItem => ({
  id: `u-${i}`,
  clientId: 'c-1',
  fileName: `f-${i}.pdf`,
  folderName: 'Group',
  path: `Group/f-${i}.pdf`,
  fileType: 'pdf',
  fileSize: 10,
  uploadedAt: new Date(Date.UTC(2026, 10, 20) - i * 60_000).toISOString(),
  groupName: 'Group',
  url: null,
})

describe('recentFiles', () => {
  const docs = Array.from({ length: 15 }, (_, i) => doc(i))

  it('shows the latest files when nothing is focused', () => {
    expect(recentFiles(docs).map((d) => d.id)).toEqual(docs.slice(0, RECENT_FILES).map((d) => d.id))
  })

  it('adds a focused file that newer files pushed out, once', () => {
    expect(recentFiles(docs, 'u-13').map((d) => d.id)).toEqual([...docs.slice(0, RECENT_FILES).map((d) => d.id), 'u-13'])
    expect(recentFiles(docs, 'u-2')).toHaveLength(RECENT_FILES)
  })

  it('ignores an id that is not this client\'s file', () => {
    expect(recentFiles(docs, 'someone-else')).toHaveLength(RECENT_FILES)
  })
})
