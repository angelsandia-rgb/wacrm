import {
  ForbiddenError,
  requireRole as requireAccountRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import type { AccountRole } from '@/lib/auth/roles'

/**
 * Authenticate an API caller, enforce the requested role and verify that
 * the account owns the clinic vertical. The industry is loaded in the
 * existing account-context query, so this gate adds no database round trip.
 */
export async function requireClinicRole(min: AccountRole): Promise<AccountContext> {
  const context = await requireAccountRole(min)
  if (context.account.industryVertical !== 'clinica') {
    throw new ForbiddenError('La vertical de clínica no está habilitada para esta empresa')
  }
  return context
}

// Clinic routes can keep the familiar `requireRole` name while importing
// from this module; exporting the response helper keeps those imports small.
export const requireRole = requireClinicRole
export { toErrorResponse }
