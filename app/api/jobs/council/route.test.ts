import { afterEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('@/lib/council/job', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/council/job')>()),
  runCouncilJob: (o: unknown) => run(o),
}))

import { GET } from './route'

const req = (auth = 'Bearer abc') => new Request('http://localhost/api/jobs/council', { headers: { authorization: auth } })

afterEach(() => {
  vi.unstubAllEnvs()
  run.mockReset()
})

describe('/api/jobs/council COUNCIL_START_DATE', () => {
  it('passes the start date as 00:00 IST, or null when unset', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    run.mockResolvedValue({ job: 'council', dryRun: true, processed: 0, written: 0, errors: [] })
    await GET(req())
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ since: null }))
    vi.stubEnv('COUNCIL_START_DATE', '2026-10-19')
    await GET(req())
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ since: '2026-10-18T18:30:00.000Z' }))
  })

  it('a bad start date fails the run (500) and never starts the council', async () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    vi.stubEnv('COUNCIL_START_DATE', '19/10/2026')
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).errors[0]).toMatch(/COUNCIL_START_DATE/)
    expect(run).not.toHaveBeenCalled()
  })
})
