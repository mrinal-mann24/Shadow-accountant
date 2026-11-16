import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertCronAuth, jobHttpStatus, jobsWriteEnabled, type JobResult } from './guard'

function req(auth?: string): Request {
  return new Request('http://localhost/api/jobs/x', { headers: auth ? { authorization: auth } : {} })
}

async function rejection(fn: () => void): Promise<Response> {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(Response)
    return e as Response
  }
  throw new Error('expected assertCronAuth to throw')
}

afterEach(() => vi.unstubAllEnvs())

describe('assertCronAuth', () => {
  it('passes with the right bearer token', () => {
    vi.stubEnv('CRON_SECRET', 's3cret-value')
    expect(() => assertCronAuth(req('Bearer s3cret-value'))).not.toThrow()
    expect(() => assertCronAuth(req('bearer   s3cret-value  '))).not.toThrow()
  })

  it('rejects a wrong token with 401', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret-value')
    const res = await rejection(() => assertCronAuth(req('Bearer nope')))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorised' })
  })

  it('rejects a missing header, wrong scheme or prefix of the secret', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret-value')
    expect((await rejection(() => assertCronAuth(req()))).status).toBe(401)
    expect((await rejection(() => assertCronAuth(req('Basic s3cret-value')))).status).toBe(401)
    expect((await rejection(() => assertCronAuth(req('Bearer s3cret')))).status).toBe(401)
    expect((await rejection(() => assertCronAuth(req('s3cret-value')))).status).toBe(401)
  })

  it('fails closed when CRON_SECRET is not set or blank', async () => {
    vi.stubEnv('CRON_SECRET', '')
    expect((await rejection(() => assertCronAuth(req('Bearer ')))).status).toBe(401)
    expect((await rejection(() => assertCronAuth(req('Bearer anything')))).status).toBe(401)
    vi.stubEnv('CRON_SECRET', '   ')
    expect((await rejection(() => assertCronAuth(req('Bearer    ')))).status).toBe(401)
  })
})

describe('jobsWriteEnabled', () => {
  it('is false by default', () => {
    vi.stubEnv('JOBS_WRITE_ENABLED', undefined)
    expect(jobsWriteEnabled()).toBe(false)
  })

  it.each([
    ['true', true],
    ['TRUE', true],
    [' true ', true],
    ['false', false],
    ['1', false],
    ['yes', false],
    ['', false],
  ])('JOBS_WRITE_ENABLED=%j gives %s for a listed job', (value, expected) => {
    vi.stubEnv('JOBS_WRITE_ENABLED', value)
    vi.stubEnv('JOBS_WRITE_ONLY', 'council')
    expect(jobsWriteEnabled('council')).toBe(expected)
  })
})

describe('jobsWriteEnabled with JOBS_WRITE_ONLY', () => {
  it('lets only the listed jobs write', () => {
    vi.stubEnv('JOBS_WRITE_ENABLED', 'true')
    vi.stubEnv('JOBS_WRITE_ONLY', ' health-score , Council ')
    expect(jobsWriteEnabled('health-score')).toBe(true)
    expect(jobsWriteEnabled('council')).toBe(true)
    expect(jobsWriteEnabled('embed')).toBe(false)
    expect(jobsWriteEnabled()).toBe(false)
  })

  it('never turns writes on by itself', () => {
    vi.stubEnv('JOBS_WRITE_ENABLED', 'false')
    vi.stubEnv('JOBS_WRITE_ONLY', 'council')
    expect(jobsWriteEnabled('council')).toBe(false)
  })

  it('fails closed: a blank or missing list means no job writes', () => {
    vi.stubEnv('JOBS_WRITE_ENABLED', 'true')
    vi.stubEnv('JOBS_WRITE_ONLY', '')
    expect(jobsWriteEnabled('embed')).toBe(false)
    expect(jobsWriteEnabled('health-score')).toBe(false)
    expect(jobsWriteEnabled()).toBe(false)
    vi.stubEnv('JOBS_WRITE_ONLY', undefined)
    expect(jobsWriteEnabled('hubspot-sync')).toBe(false)
  })
})

describe('jobHttpStatus', () => {
  const r = (o: Partial<JobResult>): JobResult => ({ job: 'x', dryRun: false, processed: 0, written: 0, errors: [], ...o })

  it('is 200 with no errors, even when nothing was written', () => {
    expect(jobHttpStatus(r({}))).toBe(200)
    expect(jobHttpStatus(r({ dryRun: true, processed: 5 }))).toBe(200)
  })

  it('is 200 for partial per-item errors', () => {
    expect(jobHttpStatus(r({ processed: 10, written: 9, errors: ['c9: boom'] }))).toBe(200)
    expect(jobHttpStatus(r({ dryRun: true, processed: 10, errors: ['c9: boom'] }))).toBe(200)
  })

  it('is 500 when a fatal step failed', () => {
    expect(jobHttpStatus(r({ processed: 10, written: 10, errors: ['upsert'], fatal: true }))).toBe(500)
    expect(jobHttpStatus(r({ dryRun: true, errors: ['HUBSPOT_ACCESS_TOKEN is not set'], fatal: true }))).toBe(500)
  })

  it('is 500 when a write run wrote nothing and had errors, or every item failed', () => {
    expect(jobHttpStatus(r({ processed: 3, written: 0, errors: ['a'] }))).toBe(500)
    expect(jobHttpStatus(r({ dryRun: true, processed: 2, errors: ['a', 'b'] }))).toBe(500)
  })
})
