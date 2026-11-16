import { describe, expect, it } from 'vitest'
import { isActiveClient, matchesStatusFilter } from './client-status'

describe('isActiveClient', () => {
  it('treats only Inactive (any case) as inactive, so a missing status never hides a client', () => {
    expect(isActiveClient('Active')).toBe(true)
    expect(isActiveClient(null)).toBe(true)
    expect(isActiveClient('')).toBe(true)
    expect(isActiveClient('Inactive')).toBe(false)
    expect(isActiveClient(' inactive ')).toBe(false)
  })
})

describe('matchesStatusFilter', () => {
  it('filters by active, inactive or all', () => {
    expect(matchesStatusFilter('Active', 'active')).toBe(true)
    expect(matchesStatusFilter('Inactive', 'active')).toBe(false)
    expect(matchesStatusFilter('Inactive', 'inactive')).toBe(true)
    expect(matchesStatusFilter(null, 'inactive')).toBe(false)
    expect(matchesStatusFilter('Inactive', 'all')).toBe(true)
  })
})
