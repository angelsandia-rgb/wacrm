import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn() }))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: h.requireRole }
})

import { ForbiddenError } from '@/lib/auth/account'
import { requireClinicRole } from './auth'

beforeEach(() => {
  h.requireRole.mockResolvedValue({
    account: { id: 'acct-1', name: 'Clínica', industryVertical: 'clinica' },
  })
})

describe('requireClinicRole', () => {
  it('keeps the requested role check and accepts a clinic account', async () => {
    await expect(requireClinicRole('agent')).resolves.toMatchObject({
      account: { industryVertical: 'clinica' },
    })
    expect(h.requireRole).toHaveBeenCalledWith('agent')
  })

  it('rejects API access from an account without the clinic vertical', async () => {
    h.requireRole.mockResolvedValue({
      account: { id: 'acct-1', name: 'Hotel', industryVertical: 'hotel' },
    })
    await expect(requireClinicRole('viewer')).rejects.toBeInstanceOf(ForbiddenError)
  })
})
