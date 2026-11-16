import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  assignClient: vi.fn(),
  setUserRole: vi.fn(),
  retryProcessing: vi.fn(),
  setCouncilEnabled: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }))
vi.mock('@/lib/auth/users', () => ({ setUserRole: mocks.setUserRole }))
vi.mock('@/lib/data', () => ({
  assignClient: mocks.assignClient,
  retryProcessing: mocks.retryProcessing,
  setCouncilEnabled: mocks.setCouncilEnabled,
}))

import { assignClientAction, setUserRoleAction } from './actions'
import { retryProcessingAction, setCouncilEnabledAction } from '../engineer/actions'

const admin = { id: 'u1', email: 'a@x.in', name: 'A', role: 'admin', vaId: null }
const engineer = { id: 'u2', email: 'e@x.in', name: 'E', role: 'engineer', vaId: null }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('admin actions', () => {
  it('assignClientAction checks the admin role and saves', async () => {
    mocks.requireUser.mockResolvedValue(admin)
    await expect(assignClientAction('c1', 'v1')).resolves.toEqual({ ok: true })
    expect(mocks.requireUser).toHaveBeenCalledWith(['admin'])
    expect(mocks.assignClient).toHaveBeenCalledWith(admin, 'c1', 'v1')
    expect(mocks.revalidatePath).toHaveBeenCalled()
  })

  it('assignClientAction passes null to unassign and rejects bad input without calling data', async () => {
    mocks.requireUser.mockResolvedValue(admin)
    await assignClientAction('c1', null)
    expect(mocks.assignClient).toHaveBeenCalledWith(admin, 'c1', null)
    mocks.assignClient.mockClear()
    await expect(assignClientAction('', 'v1')).resolves.toEqual({ ok: false, error: 'Client not found.' })
    await expect(assignClientAction('c1', '')).resolves.toEqual({ ok: false, error: 'Accountant not found.' })
    expect(mocks.assignClient).not.toHaveBeenCalled()
  })

  it('maps data errors to user messages', async () => {
    mocks.requireUser.mockResolvedValue(admin)
    mocks.assignClient.mockRejectedValueOnce(new Error('Accountant not found.'))
    await expect(assignClientAction('c1', 'v9')).resolves.toEqual({ ok: false, error: 'Accountant not found.' })
    mocks.assignClient.mockRejectedValueOnce(new Error('assignClient: connection reset'))
    await expect(assignClientAction('c1', 'v1')).resolves.toEqual({ ok: false, error: 'Something went wrong. Please try again.' })
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('lets requireUser redirects through (not caught)', async () => {
    const redirect = new Error('NEXT_REDIRECT')
    mocks.requireUser.mockRejectedValue(redirect)
    await expect(assignClientAction('c1', 'v1')).rejects.toBe(redirect)
    await expect(setUserRoleAction('u3', 'admin')).rejects.toBe(redirect)
  })

  it('setUserRoleAction validates the role and shows ForbiddenError text', async () => {
    mocks.requireUser.mockResolvedValue(admin)
    await expect(setUserRoleAction('u3', 'owner' as never)).resolves.toEqual({ ok: false, error: 'Unknown role.' })
    expect(mocks.setUserRole).not.toHaveBeenCalled()
    mocks.setUserRole.mockRejectedValueOnce(new ForbiddenError('You cannot change your own role.'))
    await expect(setUserRoleAction('u1', 'engineer')).resolves.toEqual({ ok: false, error: 'You cannot change your own role.' })
    await expect(setUserRoleAction('u3', null)).resolves.toEqual({ ok: true })
    expect(mocks.setUserRole).toHaveBeenLastCalledWith(admin, 'u3', null)
  })
})

describe('engineer actions', () => {
  it('retryProcessingAction requires engineer and calls retryProcessing', async () => {
    mocks.requireUser.mockResolvedValue(engineer)
    await expect(retryProcessingAction('m1')).resolves.toEqual({ ok: true })
    expect(mocks.requireUser).toHaveBeenCalledWith(['engineer'])
    expect(mocks.retryProcessing).toHaveBeenCalledWith(engineer, 'm1')
  })

  it('setCouncilEnabledAction validates input and shows view-as errors', async () => {
    mocks.requireUser.mockResolvedValue(engineer)
    await expect(setCouncilEnabledAction('c1', 'yes' as never)).resolves.toEqual({ ok: false, error: 'That change was not valid.' })
    mocks.setCouncilEnabled.mockRejectedValueOnce(new ViewAsReadOnlyError())
    await expect(setCouncilEnabledAction('c1', true)).resolves.toEqual({ ok: false, error: new ViewAsReadOnlyError().message })
    await expect(setCouncilEnabledAction('c1', false)).resolves.toEqual({ ok: true })
    expect(mocks.setCouncilEnabled).toHaveBeenLastCalledWith(engineer, 'c1', false)
  })
})
