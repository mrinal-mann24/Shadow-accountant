import { describe, expect, it } from 'vitest'
import { safeNextPath } from './roles'

describe('safeNextPath (open redirect after sign-in)', () => {
  it('keeps normal in-app paths', () => {
    expect(safeNextPath('/clients/abc?tab=files')).toBe('/clients/abc?tab=files')
    expect(safeNextPath('/tickets')).toBe('/tickets')
  })
  it('refuses paths a browser would turn into another site', () => {
    for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', '/\r//evil.com', 'https://evil.com', 'evil.com']) {
      expect(safeNextPath(bad)).toBe('/home')
    }
  })
  it('falls back when empty', () => {
    expect(safeNextPath(null)).toBe('/home')
    expect(safeNextPath('', '/tickets')).toBe('/tickets')
  })
})
