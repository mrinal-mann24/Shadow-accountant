import { afterEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('@/lib/teams/notify', () => ({
  JOB: 'teams-notify',
  runTeamsNotifyJob: (o: unknown) => run(o),
}))

import { GET, POST } from './route'

const req = (auth?: string) =>
  new Request('http://localhost/api/jobs/teams-notify', { headers: auth ? { authorization: auth } : {} })
const ok = (dryRun: boolean) => ({ job: 'teams-notify', dryRun, processed: 1, written: dryRun ? 0 : 1, errors: [] })

afterEach(() => {
  vi.unstubAllEnvs()
  run.mockReset()
})

describe('/api/jobs/teams-notify', () => {
  it('401 without the cron secret, and the job never runs', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    expect((await GET(req())).status).toBe(401)
    expect((await POST(req('Bearer wrong'))).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it('dry run unless teams-notify is listed in JOBS_WRITE_ONLY', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    vi.stubEnv('JOBS_WRITE_ENABLED', 'true')
    vi.stubEnv('JOBS_WRITE_ONLY', 'council')
    run.mockResolvedValue(ok(true))
    expect((await GET(req('Bearer abc'))).status).toBe(200)
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ write: false, now: expect.any(Date) }))

    vi.stubEnv('JOBS_WRITE_ONLY', 'council,teams-notify')
    run.mockResolvedValue(ok(false))
    expect((await POST(req('Bearer abc'))).status).toBe(200)
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ write: true }))
  })

  it('500 when the job throws or reports a fatal error', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    run.mockRejectedValue(new Error('boom'))
    const res = await GET(req('Bearer abc'))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ job: 'teams-notify', dryRun: true, errors: ['boom'] })

    run.mockResolvedValue({ job: 'teams-notify', dryRun: false, processed: 0, written: 0, errors: ['env'], fatal: true })
    expect((await GET(req('Bearer abc'))).status).toBe(500)
  })
})
