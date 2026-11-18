import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  assertNotViewingAs: vi.fn(),
  followUpAction: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('@/lib/auth/session', async () => {
  const roles = await import('@/lib/auth/roles')
  return {
    requireUser: mocks.requireUser,
    assertNotViewingAs: mocks.assertNotViewingAs,
    ForbiddenError: roles.ForbiddenError,
    ViewAsReadOnlyError: roles.ViewAsReadOnlyError,
  }
})
vi.mock('@/lib/data', () => ({ followUpAction: mocks.followUpAction }))

import { followUpFormAction } from './follow-up-actions'

const asha = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const ID = '3f6c2a8e-1b2d-4c5e-9f00-112233445566'
const form = (id: string, action: string) => {
  const f = new FormData()
  f.set('id', id)
  f.set('action', action)
  return f
}
const prev = { ok: true, error: null }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.requireUser.mockResolvedValue(asha)
})

describe('followUpFormAction', () => {
  it('runs the action and revalidates', async () => {
    mocks.followUpAction.mockResolvedValue({})
    await expect(followUpFormAction(prev, form(ID, 'extend'))).resolves.toEqual({ ok: true, error: null })
    expect(mocks.followUpAction).toHaveBeenCalledWith(asha, ID, 'extend')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/home')
  })

  it('rejects bad input without calling the data layer', async () => {
    expect(await followUpFormAction(prev, form('not-a-uuid', 'done'))).toEqual({ ok: false, error: 'That change is not valid.' })
    expect(await followUpFormAction(prev, form(ID, 'delete'))).toEqual({ ok: false, error: 'That change is not valid.' })
    expect(mocks.followUpAction).not.toHaveBeenCalled()
  })

  it.each([
    [new ViewAsReadOnlyError(), 'Read only while viewing as another accountant.'],
    [new ForbiddenError(), 'You cannot change this follow-up.'],
    [new Error('Follow-up not found.'), 'Follow-up not found.'],
    [new Error('This follow-up is already closed.'), 'This follow-up is already closed.'],
    [new Error('Only promises and document requests can be extended.'), 'Only promises and document requests can be extended.'],
    [new Error('Unknown follow-up action.'), 'That change is not valid.'],
  ])('maps a known error to friendly text (%s)', async (err, text) => {
    mocks.followUpAction.mockRejectedValue(err)
    expect(await followUpFormAction(prev, form(ID, 'done'))).toEqual({ ok: false, error: text })
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('view as is stopped before the data layer', async () => {
    mocks.assertNotViewingAs.mockImplementationOnce(() => {
      throw new ViewAsReadOnlyError()
    })
    expect(await followUpFormAction(prev, form(ID, 'done'))).toEqual({
      ok: false,
      error: 'Read only while viewing as another accountant.',
    })
    expect(mocks.followUpAction).not.toHaveBeenCalled()
  })

  it.each([
    new Error('followUpAction: relation "follow_ups" does not exist'),
    new Error('connection refused at 10.0.0.1'),
    'a thrown string',
    null,
  ])('never returns a raw message for an unknown error (%s)', async (err) => {
    mocks.followUpAction.mockRejectedValue(err)
    expect(await followUpFormAction(prev, form(ID, 'done'))).toEqual({
      ok: false,
      error: 'Could not update the follow-up. Please try again.',
    })
    expect(console.error).toHaveBeenCalled()
  })
})
