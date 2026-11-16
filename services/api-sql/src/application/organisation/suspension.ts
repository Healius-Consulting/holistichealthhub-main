import { HttpError } from '../../domain/common/errors.js';
import { isPlatformTestOrganisation } from '../../domain/organisation/training-directory.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';

type SuspensionSubject = Pick<OrganisationRecord, 'id' | 'status' | 'archivedAt' | 'gphcNumber' | 'classification'>;

/**
 * Suspending stops a live pharmacy's use of the platform: its staff are signed out
 * and refused, its eligibility link stops taking patients and it leaves the finder.
 * Records are kept, and payments already in flight still settle. Only a live
 * pharmacy can be suspended (decided 16 Nov 2026); returns null when nothing changes.
 */
export function suspendStatus(organisation: SuspensionSubject): OrganisationRecord['status'] | null {
  if (organisation.status === 'PAUSED') return null;
  if (organisation.archivedAt) {
    throw new HttpError(409, 'A rejected pharmacy cannot be suspended.', 'SUSPEND_NOT_ALLOWED');
  }
  if (isPlatformTestOrganisation(organisation)) {
    throw new HttpError(409, 'Test pharmacies stay on and cannot be suspended.', 'SUSPEND_NOT_ALLOWED');
  }
  if (organisation.status !== 'LIVE') {
    throw new HttpError(409, 'Only a live pharmacy can be suspended. A pharmacy still being set up can be rejected instead.', 'SUSPEND_NOT_ALLOWED');
  }
  return 'PAUSED';
}

/**
 * Lifting returns the pharmacy to where its Curaleaf connection puts it: live on
 * production credentials, otherwise back to awaiting Curaleaf. Returns null when
 * the pharmacy is not suspended.
 */
export function liftSuspensionStatus(
  organisation: Pick<OrganisationRecord, 'status'>,
  curaleafEnvironment: 'TEST' | 'PRODUCTION' | string | null,
): OrganisationRecord['status'] | null {
  if (organisation.status !== 'PAUSED') return null;
  return curaleafEnvironment === 'PRODUCTION' ? 'LIVE' : 'ONBOARDING';
}
