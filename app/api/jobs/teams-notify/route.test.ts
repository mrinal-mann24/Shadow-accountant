import { afterEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('@/lib/teams/notify', () => ({
  JOB: 'teams-notify',
  runTeamsNotifyJob: (o: unknown) => run(o),
}))

const prune = vi.fn<(before: string) => Promise<number>>(async () => 0)
vi.mock('@/lib/teams/chat-store', () => ({ supabaseTeamsChatStore: { prune: (before: string) => prune(before) } }))

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

  it('deletes old Teams chat rows only on a write run, and a prune error never fails the job', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    vi.stubEnv('JOBS_WRITE_ENABLED', 'true')
    vi.stubEnv('JOBS_WRITE_ONLY', 'council')
    prune.mockClear()
    run.mockResolvedValue(ok(true))
    await GET(req('Bearer abc'))
    expect(prune).not.toHaveBeenCalled()

    vi.stubEnv('JOBS_WRITE_ONLY', 'teams-notify')
    run.mockResolvedValue(ok(false))
    prune.mockRejectedValueOnce(new Error('db down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await GET(req('Bearer abc'))
    err.mockRestore()
    expect(r.status).toBe(200)
    expect(prune).toHaveBeenCalledTimes(1)
    const before = Date.parse(prune.mock.calls[0][0])
    expect(Date.now() - before).toBeGreaterThan(6.9 * 24 * 60 * 60_000)
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
