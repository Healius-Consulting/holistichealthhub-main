import type { DecodedIdToken } from 'firebase-admin/auth';
import type { PortalAdmissionResult } from '../repositories/ports/identity.port.js';
import type { ProtectedSurface, StaffRole } from './request-context.js';

export interface AdmissionValidationInput {
  claims: DecodedIdToken;
  admission: PortalAdmissionResult;
  sessionHash: string;
  surface?: ProtectedSurface | 'any';
  now?: number;
}

export type AdmissionFailureCode =
  | 'PHARMACY_SUSPENDED'
  | 'PHARMACY_NOT_AVAILABLE'
  | 'SESSION_NOT_FOUND'
  | 'STAFF_NOT_FOUND'
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_INACTIVE'
  | 'STAFF_SCOPE_INVALID'
  | 'SESSION_REVOKED'
  | 'SESSION_EXPIRED'
  | 'SESSION_IDLE_EXPIRED'
  | 'SURFACE_DENIED'
  | 'ROLE_MISMATCH';

export interface AdmissionFailure {
  status: 401 | 403;
  code: AdmissionFailureCode;
  event: string;
}

function normalizeStaffRole(role: unknown): string {
  if (typeof role !== 'string') return '';
  const clean = role.toUpperCase().replace(/[-_]/g, '_');
  if (clean === 'HHH_ADMIN' || clean === 'ADMIN') return 'HHH_ADMIN';
  if (clean === 'PHARMACY_STAFF' || clean === 'PHARMACY') return 'PHARMACY_STAFF';
  return clean;
}

function normalizeScopeId(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replaceAll('-', '');
}

export function validatePortalAdmission(input: AdmissionValidationInput): AdmissionFailure | null {
  const { claims, admission, surface = 'any', now = Date.now() } = input;
  const { session, staff } = admission;

  if (!session) {
    return { status: 401, code: 'SESSION_NOT_FOUND', event: 'auth.session_not_found' };
  }

  if (!staff) {
    return { status: 403, code: 'STAFF_NOT_FOUND', event: 'auth.staff_not_found' };
  }

  if (staff.disabled || staff.status === 'DISABLED' || staff.status === 'REMOVED') {
    return { status: 403, code: 'ACCOUNT_DISABLED', event: 'auth.account_disabled' };
  }

  if (staff.status !== 'ACTIVE') {
    return { status: 403, code: 'ACCOUNT_INACTIVE', event: 'auth.account_inactive' };
  }

  // Verify role alignment
  const claimRole = normalizeStaffRole(claims.role);
  const staffRole = normalizeStaffRole(staff.role);
  const sessionRole = normalizeStaffRole(session.role);

  if (staffRole !== claimRole || sessionRole !== claimRole) {
    return { status: 403, code: 'ROLE_MISMATCH', event: 'auth.role_mismatch' };
  }

  // Verify surface alignment
  if (surface === 'admin' && staffRole !== 'HHH_ADMIN') {
    return { status: 403, code: 'SURFACE_DENIED', event: 'auth.surface_denied' };
  }
  if (surface === 'pharmacy' && staffRole !== 'PHARMACY_STAFF') {
    return { status: 403, code: 'SURFACE_DENIED', event: 'auth.surface_denied' };
  }

  if (surface !== 'any' && session.surface !== surface) {
    return { status: 403, code: 'SURFACE_DENIED', event: 'auth.surface_denied' };
  }

  // Verify tenant alignment for pharmacy staff
  if (staffRole === 'PHARMACY_STAFF') {
    const claimOrg = typeof claims.organisationId === 'string' ? claims.organisationId : typeof claims.pharmacyId === 'string' ? claims.pharmacyId : null;
    const normalizedClaimOrg = normalizeScopeId(claimOrg);
    if (claimOrg && (
      normalizeScopeId(staff.organisationId) !== normalizedClaimOrg
      || normalizeScopeId(session.organisationId) !== normalizedClaimOrg
    )) {
      return { status: 403, code: 'STAFF_SCOPE_INVALID', event: 'auth.tenant_mismatch' };
    }
  }


  // A suspended pharmacy's staff are locked out until HHH lifts the suspension.
  if (staffRole === 'PHARMACY_STAFF' && staff.organisation?.status === 'PAUSED') {
    return { status: 403, code: 'PHARMACY_SUSPENDED', event: 'auth.pharmacy_suspended' };
  }
  // An existing Curaleaf customer HHH marked Not available has no access either.
  if (staffRole === 'PHARMACY_STAFF' && staff.organisation?.status === 'NOT_AVAILABLE') {
    return { status: 403, code: 'PHARMACY_NOT_AVAILABLE', event: 'auth.pharmacy_not_available' };
  }

  // Check revocation and expiry
  if (session.revokedAt) {
    return { status: 401, code: 'SESSION_REVOKED', event: 'auth.session_revoked' };
  }

  if (Date.parse(session.absoluteExpiresAt) <= now) {
    return { status: 401, code: 'SESSION_EXPIRED', event: 'auth.session_expired' };
  }

  if (Date.parse(session.idleExpiresAt) <= now) {
    return { status: 401, code: 'SESSION_IDLE_EXPIRED', event: 'auth.session_idle_expired' };
  }

  return null;
}
