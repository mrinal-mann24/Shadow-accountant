import { afterEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('@/lib/followups/job', () => ({
  JOB: 'follow-ups',
  runFollowUpsJob: (o: unknown) => run(o),
}))

import { GET, POST } from './route'

const req = (auth = 'Bearer abc', method = 'GET') =>
  new Request('http://localhost/api/jobs/follow-ups', { method, headers: { authorization: auth } })
const ok = { job: 'follow-ups', dryRun: true, processed: 0, written: 0, errors: [] }

afterEach(() => {
  vi.unstubAllEnvs()
  run.mockReset()
})

describe('/api/jobs/follow-ups', () => {
  it('rejects a request without the cron secret and never runs the job', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it('is a dry run unless follow-ups is listed in JOBS_WRITE_ONLY', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    run.mockResolvedValue(ok)
    vi.stubEnv('JOBS_WRITE_ENABLED', 'true')
    vi.stubEnv('JOBS_WRITE_ONLY', 'council')
    await GET(req())
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ write: false }))
    vi.stubEnv('JOBS_WRITE_ONLY', 'council,follow-ups')
    const res = await POST(req('Bearer abc', 'POST'))
    expect(res.status).toBe(200)
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ write: true, now: expect.any(Date) }))
  })

  it('passes COUNCIL_START_DATE as 00:00 IST, or null when unset', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    run.mockResolvedValue(ok)
    await GET(req())
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ since: null }))
    vi.stubEnv('COUNCIL_START_DATE', '2026-10-19')
    await GET(req())
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ since: '2026-10-18T18:30:00.000Z' }))
  })

  it('a bad start date fails the run (500) and never starts the job', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    vi.stubEnv('COUNCIL_START_DATE', '19/10/2026')
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ job: 'follow-ups', dryRun: true, processed: 0, written: 0 })
    expect(body.errors[0]).toMatch(/COUNCIL_START_DATE/)
    expect(run).not.toHaveBeenCalled()
  })

  it('a run that found no follow_ups table answers 200 with its note', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    const note = 'The follow_ups table is not created yet (supabase/applied/2026-11-18-follow-ups.sql).'
    run.mockResolvedValue({ ...ok, details: { note } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ errors: [], details: { note } })
  })

  it('a thrown job error answers 500 with the same shape', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    run.mockRejectedValue(new Error('db down'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ job: 'follow-ups', dryRun: true, processed: 0, written: 0, errors: ['db down'] })
  })
})
