import { describe, expect, it } from 'vitest'
import { BUCKETS, BUCKET_STORAGE_APPROVED, BucketStorageNotApprovedError, getClientBucket, isBucketKey, setClientBucket } from './buckets'

describe('buckets placeholder', () => {
  it('lists YTRO, DC, DS pending leadership confirmation', () => {
    expect(BUCKETS.map((b) => b.key)).toEqual(['YTRO', 'DC', 'DS'])
    expect(isBucketKey('DC')).toBe(true)
    expect(isBucketKey('onboarding')).toBe(false)
    expect(BUCKET_STORAGE_APPROVED).toBe(false)
  })

  it('reads null and refuses writes until storage is approved', async () => {
    expect(await getClientBucket('c1')).toBeNull()
    await expect(setClientBucket({ id: 'u1', email: 'a@example.com', name: 'A', role: 'admin', vaId: null }, 'c1', 'DC')).rejects.toBeInstanceOf(BucketStorageNotApprovedError)
  })
})
