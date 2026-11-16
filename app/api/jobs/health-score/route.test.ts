import { afterEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('@/lib/scoring/job', () => ({ runHealthScoreJob: (o: unknown) => run(o) }))

import { GET, POST } from './route'

const req = (url = 'http://localhost/api/jobs/health-score', auth?: string) =>
  new Request(url, { headers: auth ? { authorization: auth } : {} })

afterEach(() => {
  vi.unstubAllEnvs()
  run.mockReset()
})

describe('/api/jobs/health-score', () => {
  it('rejects requests without the cron secret and never runs the job', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it('runs dry by default and passes client ids', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    run.mockResolvedValue({ job: 'health-score', dryRun: true, processed: 2, written: 0, errors: [] })
    const res = await POST(req('http://localhost/api/jobs/health-score?clientIds=a,%20b,,', 'Bearer abc'))
    expect(res.status).toBe(200)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ write: false, clientIds: ['a', 'b'] }))
    expect((await res.json()).processed).toBe(2)
  })

  it('writes only when JOBS_WRITE_ENABLED is true and the job is listed in JOBS_WRITE_ONLY', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    vi.stubEnv('JOBS_WRITE_ENABLED', 'true')
    run.mockResolvedValue({ job: 'health-score', dryRun: false, processed: 0, written: 0, errors: [] })
    await GET(req(undefined, 'Bearer abc'))
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ write: false }))
    vi.stubEnv('JOBS_WRITE_ONLY', 'health-score')
    await GET(req(undefined, 'Bearer abc'))
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ write: true, clientIds: undefined }))
  })

  it('returns 500 when the job reports a fatal error, 200 for partial errors', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    run.mockResolvedValue({ job: 'health-score', dryRun: true, processed: 0, written: 0, errors: ['clients: boom'], fatal: true })
    expect((await GET(req(undefined, 'Bearer abc'))).status).toBe(500)
    run.mockResolvedValue({ job: 'health-score', dryRun: true, processed: 9, written: 0, errors: ['c1: boom'] })
    expect((await GET(req(undefined, 'Bearer abc'))).status).toBe(200)
  })

  it('returns a JobResult with status 500 when the job throws', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    run.mockRejectedValue(new Error('boom'))
    const res = await GET(req(undefined, 'Bearer abc'))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ job: 'health-score', errors: ['boom'] })
  })
})
